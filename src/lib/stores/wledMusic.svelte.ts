/**
 * Mode Musique de l'éclairage terrasse — CLIENT.
 *
 * L'état (activé + style) vit CÔTÉ SERVEUR (music-mode.ts) : il décrit un
 * ruban physique unique, pas une préférence d'appareil. Ce store :
 *   - reflète l'état réel via le SSE /api/wled/music/live (chip, styles,
 *     légende, niveau sonore pour la barre animée) — plus aucun flag local ;
 *   - pilote l'état par POST /api/wled/music/mode (optimiste, le SSE confirme) ;
 *   - pour L'APPAREIL QUI JOUE : heartbeat POST /api/wled/music/beat
 *     { key, part, positionMs, playing } — strictement. Les COULEURS du rendu
 *     sont la palette multicolore du style, appliquées par le serveur :
 *     rien à voir avec le morceau, jamais monochrome.
 *
 * Le heartbeat s'appuie sur `player.currentTime` (événement audio → continue
 * en arrière-plan iOS, contrairement aux timers) ; le serveur extrapole.
 */

import type { PlexTrack } from '$stores/plex.svelte';
import { musicStyleDef, WLED_MUSIC_STYLES, type WledMusicStyle } from '$lib/wled/music-styles';

export { WLED_MUSIC_STYLES };
export type { WledMusicStyle };

/** Intervalle nominal entre deux heartbeats de position (le serveur extrapole). */
const HEARTBEAT_MS = 5_000;
/** Écart position réelle vs extrapolée qui déclenche un recalage immédiat (seek). */
const DRIFT_S = 1.5;

interface LiveEvent {
  enabled?: boolean;
  style?: string;
  key?: string | null;
  playing?: boolean;
  analyzing?: boolean;
  level?: number;
  peak?: number;
}

class WledMusicStore {
  // ─── État SERVEUR (reflété par le SSE) ───
  enabled = $state(false);
  style = $state('ambiance');
  /** Analyse spectrale en cours côté serveur ? (libellé de la chip) */
  analyzing = $state(false);
  /** La musique suivie par le serveur joue-t-elle ? (légende, animation) */
  playing = $state(false);
  /** Piste suivie par le serveur (peut venir d'un autre appareil). */
  trackKey = $state<string | null>(null);

  /** Niveau sonore temps réel (0-1) et pic — CHAMPS NON RÉACTIFS : lus par la
   *  boucle rAF de l'aperçu (12,5 Hz entrant, 60 fps sortant), un $state ici
   *  re-rendrait la carte en continu. */
  liveLevel = 0;
  livePeak = 0;

  // ─── SSE (refcounté : carte montée + appareil qui joue) ───
  #es: EventSource | null = null;
  #refs = 0;
  #visHandler: (() => void) | null = null;

  get styleDef(): WledMusicStyle {
    return musicStyleDef(this.style);
  }
  /** Le style courant est-il piloté par le spectre ? */
  get reactive(): boolean {
    return this.enabled && this.styleDef.fx !== null;
  }

  /** Ouvre (refcount) le flux temps réel. Fermé quand l'onglet est masqué. */
  openLive(): void {
    this.#refs++;
    this.#connect();
    if (!this.#visHandler && typeof document !== 'undefined') {
      this.#visHandler = () => {
        if (document.visibilityState === 'hidden') this.#disconnect();
        else if (this.#refs > 0) this.#connect();
      };
      document.addEventListener('visibilitychange', this.#visHandler);
    }
  }

  closeLive(): void {
    this.#refs = Math.max(0, this.#refs - 1);
    if (this.#refs === 0) this.#disconnect();
  }

  #connect(): void {
    if (this.#es || typeof EventSource === 'undefined') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const es = new EventSource('/api/wled/music/live');
    this.#es = es;
    es.onmessage = (m) => {
      let e: LiveEvent;
      try {
        e = JSON.parse(m.data as string) as LiveEvent;
      } catch {
        return;
      }
      if (typeof e.enabled === 'boolean') this.enabled = e.enabled;
      if (typeof e.style === 'string') this.style = e.style;
      if (e.key !== undefined) this.trackKey = e.key;
      if (typeof e.playing === 'boolean') this.playing = e.playing;
      if (typeof e.analyzing === 'boolean') this.analyzing = e.analyzing;
      if (typeof e.level === 'number') this.liveLevel = e.level;
      if (typeof e.peak === 'number') this.livePeak = e.peak;
    };
    // EventSource se reconnecte tout seul sur erreur réseau — rien à faire.
  }

  #disconnect(): void {
    this.#es?.close();
    this.#es = null;
  }

  // ─── Pilotage (POST /mode — optimiste, le SSE confirme) ───

  #postMode(patch: { enabled?: boolean; style?: string }): void {
    void fetch('/api/wled/music/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }).catch(() => undefined);
  }

  setEnabled(on: boolean): void {
    this.enabled = on; // optimiste
    if (on) this.#lastBeatAt = 0; // heartbeat immédiat si une musique joue ici
    this.#postMode({ enabled: on });
  }

  setStyle(key: string): void {
    if (!WLED_MUSIC_STYLES.some((s) => s.key === key) || key === this.style) return;
    this.style = key; // optimiste
    this.#lastBeatAt = 0;
    this.#postMode({ style: key });
  }

  /** Une ambiance / couleur / effet / palette reprend la main — PARTOUT.
   *  (L'interrupteur et la luminosité, eux, ne coupent pas le mode.) */
  releaseControl(): void {
    if (!this.enabled) return;
    this.enabled = false; // optimiste
    this.#postMode({ enabled: false });
  }

  // ─── Heartbeat de l'appareil qui joue ───

  #lastTrackKey: string | null = null;
  #lastTrackPart: string | null = null;
  #lastPlaying: boolean | null = null;
  #lastPosS = 0;
  #lastBeatAt = 0;
  #lastBeatPos = 0;
  #lastBeatPlaying: boolean | null = null;

  #beat(key: string, part: string, playing: boolean, currentTimeS: number): void {
    if (!this.enabled) return;
    const now = Date.now();
    const expected = this.#lastBeatPos + (playing ? (now - this.#lastBeatAt) / 1000 : 0);
    const drift = Math.abs(currentTimeS - expected);
    const due =
      now - this.#lastBeatAt >= HEARTBEAT_MS ||
      drift > DRIFT_S ||
      playing !== this.#lastBeatPlaying;
    if (!due) return;
    this.#lastBeatAt = now;
    this.#lastBeatPos = currentTimeS;
    this.#lastBeatPlaying = playing;
    void fetch('/api/wled/music/beat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key,
        part,
        positionMs: Math.round(currentTimeS * 1000),
        playing
      })
    }).catch(() => undefined); // heartbeat perdu : le suivant recalera
  }

  /**
   * À appeler quand piste, lecture ou position changent (depuis un $effect du
   * layout). Idempotent : ignore tout tant que rien n'a changé.
   */
  sync(track: PlexTrack | null, playing: boolean, currentTimeS = 0): void {
    if (!this.enabled) return;

    // File de lecture vidée (croix du mini-player) : dernier heartbeat en
    // pause sur la dernière piste connue → le serveur fige le rendu.
    if (!track) {
      if (this.#lastTrackKey && this.#lastTrackPart && this.#lastPlaying !== false) {
        this.#lastPlaying = false;
        this.#lastBeatAt = 0;
        this.#beat(this.#lastTrackKey, this.#lastTrackPart, false, this.#lastPosS);
      }
      return;
    }

    this.#lastPosS = currentTimeS;

    if (track.key !== this.#lastTrackKey) {
      this.#lastTrackKey = track.key;
      this.#lastTrackPart = track.part ?? null;
      this.#lastPlaying = playing;
      this.#lastBeatAt = 0; // heartbeat immédiat (le serveur lance l'analyse)
    } else if (playing !== this.#lastPlaying) {
      this.#lastPlaying = playing;
      this.#lastBeatAt = 0; // transition pause/lecture : recalage immédiat
    }

    if (track.part) this.#beat(track.key, track.part, playing, currentTimeS);
  }
}

export const wledMusic = new WledMusicStore();
