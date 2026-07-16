/**
 * Suivi de la musique par l'éclairage terrasse.
 *
 * Deux niveaux, au choix (« style ») :
 *   - « Ambiance » : couleurs dominantes de la pochette + fondu doux — aucune
 *     donnée temps réel, juste l'esprit du morceau.
 *   - Styles RÉACTIFS (VU-mètre, Vagues, Gouttes, Cascade, DJ) : le spectre du
 *     morceau est analysé numériquement côté serveur (FFT du fichier, pas de
 *     micro) et streamé au module en sound-sync, calé sur la position de
 *     lecture. Les effets audio natifs du firmware font le rendu ; la palette
 *     reste les couleurs de la pochette.
 *
 * Le pilotage part de L'APPAREIL où la musique joue. Le heartbeat de position
 * s'appuie sur `player.currentTime` (événement audio → continue en arrière-plan
 * iOS, contrairement aux timers) ; le serveur extrapole entre deux heartbeats.
 * Préférences (activé + style) persistées par appareil.
 */

import { wled } from '$stores/wled.svelte';
import { plexImg, type PlexTrack } from '$stores/plex.svelte';
import { extractArtworkColors } from '$utils/artwork-colors';
import type { RGB } from '$stores/wled.svelte';

const LS_KEY = 'domo.wled.music';
const LS_STYLE = 'domo.wled.music.style';
/** Intervalle nominal entre deux heartbeats de position (le serveur extrapole). */
const HEARTBEAT_MS = 5_000;
/** Écart position réelle vs extrapolée qui déclenche un recalage immédiat (seek). */
const DRIFT_S = 1.5;

export interface WledMusicStyle {
  key: string;
  label: string;
  /** Effet WLED (ordre de préférence). null = fondu « ambiance » (pas de stream). */
  fx: string[] | null;
  /** Vitesse / intensité de l'effet (chaque effet audio a son point d'équilibre). */
  sx?: number;
  ix?: number;
  /** Description une ligne (aide au choix). */
  hint: string;
}

// Effets choisis FIDÈLES À LA PALETTE (couleurs de la pochette) — les effets
// qui colorient par fréquence en HSV brut (Freqwave…) affichent des teintes
// sans rapport avec le morceau : écartés après mesure sur le ruban réel.
// Seul « DJ » assume des couleurs libres (dit dans son hint).
export const WLED_MUSIC_STYLES: WledMusicStyle[] = [
  { key: 'ambiance', label: 'Ambiance', fx: null, hint: 'Couleurs de la pochette, fondu doux' },
  {
    key: 'vu',
    label: 'VU-mètre',
    fx: ['Gravcenter', 'Gravimeter'],
    sx: 128,
    ix: 128,
    hint: 'Le niveau remplit le ruban depuis le centre'
  },
  {
    key: 'vagues',
    label: 'Vagues',
    fx: ['Pixelwave', 'Matripix'],
    sx: 110,
    ix: 140,
    hint: 'Des impulsions défilent au rythme'
  },
  {
    key: 'gouttes',
    label: 'Gouttes',
    fx: ['Puddlepeak', 'Puddles', 'Ripple Peak'],
    sx: 128,
    ix: 200,
    hint: 'Des éclats sur les temps forts'
  },
  {
    key: 'cascade',
    label: 'Cascade',
    fx: ['Waterfall'],
    sx: 130,
    ix: 128,
    hint: 'Une chute continue qui suit le morceau'
  },
  {
    key: 'dj',
    label: 'DJ',
    fx: ['DJ Light'],
    sx: 140,
    ix: 160,
    hint: 'Flashs énergiques, couleurs libres'
  }
];

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* perte acceptée */
  }
}

/** Timeline compacte du morceau (volume + battements, 25 fps) — la MÊME donnée
 *  que le stream sound-sync : l'aperçu de la carte l'anime pour bouger comme
 *  le ruban. */
export interface LiveTimeline {
  fps: number;
  vol: Uint8Array;
  peak: Uint8Array;
}

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class WledMusicStore {
  enabled = $state(false);
  /** Style courant (clé de WLED_MUSIC_STYLES). */
  style = $state('ambiance');
  /** Couleurs du morceau en cours (pastille de la chip « Musique »). */
  colors = $state<RGB[] | null>(null);
  /** Analyse spectrale de la piste en cours côté serveur ? (indicatif UI) */
  analyzing = $state(false);
  /** Timeline du morceau en cours (pour l'aperçu animé de la carte). */
  liveTimeline = $state<LiveTimeline | null>(null);
  #timelineFor: string | null = null;

  #lastTrackKey: string | null = null;
  #lastPlaying: boolean | null = null;
  /** Jeton anti-course : seule la dernière extraction lancée a le droit d'écrire. */
  #gen = 0;
  // Heartbeat sound-sync
  #lastBeatAt = 0;
  #lastBeatPos = 0;
  #lastBeatPlaying: boolean | null = null;
  /** Réponses « ni prêt ni en analyse » consécutives (= analyse échouée). */
  #notReadyCount = 0;
  /** Piste retombée en rendu « ambiance » faute de spectre (une fois par piste). */
  #fellBack = false;

  constructor() {
    if (typeof localStorage !== 'undefined') {
      this.enabled = lsGet(LS_KEY) === '1';
      const st = lsGet(LS_STYLE);
      if (st && WLED_MUSIC_STYLES.some((s) => s.key === st)) this.style = st;
    }
  }

  get styleDef(): WledMusicStyle {
    return WLED_MUSIC_STYLES.find((s) => s.key === this.style) ?? WLED_MUSIC_STYLES[0];
  }
  /** Le style courant est-il piloté par le spectre (stream serveur) ? */
  get reactive(): boolean {
    return this.enabled && this.styleDef.fx !== null;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    lsSet(LS_KEY, on ? '1' : '0');
    if (!on) {
      this.#lastTrackKey = null;
      this.#lastPlaying = null;
      this.analyzing = false;
      this.liveTimeline = null;
      this.#timelineFor = null;
      this.#stopStream();
    }
  }

  /** Timeline compacte (volume/battements) de la piste — pour l'aperçu animé.
   *  Chargée quand le serveur annonce la piste prête ; une fois par piste.
   *  PUBLIC : l'aperçu l'appelle aussi pour la piste jouée par un AUTRE
   *  appareil (suivi de l'état serveur du streamer). */
  ensureTimeline(key: string): void {
    if (this.#timelineFor === key) return;
    this.#timelineFor = key;
    void fetch(`/api/wled/music/timeline?key=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { fps: number; vol: string; peak: string } | null) => {
        if (!d || this.#timelineFor !== key) return;
        this.liveTimeline = { fps: d.fps, vol: b64ToU8(d.vol), peak: b64ToU8(d.peak) };
      })
      .catch(() => undefined);
  }

  setStyle(key: string): void {
    if (!WLED_MUSIC_STYLES.some((s) => s.key === key) || key === this.style) return;
    this.style = key;
    lsSet(LS_STYLE, key);
    if (!this.enabled) return;
    // Applique le nouveau rendu immédiatement (couleurs déjà extraites).
    if (this.colors) {
      void wled.applyMusicColors(this.colors, this.#lastPlaying ?? true, this.styleDef);
    }
    if (!this.reactive) this.#stopStream();
    else this.#lastBeatAt = 0; // force un heartbeat au prochain sync
  }

  /** Un réglage manuel (ambiance, couleur, effet) reprend la main. */
  releaseControl(): void {
    if (this.enabled) this.setEnabled(false);
  }

  #stopStream(): void {
    void fetch('/api/wled/music/beat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stop: true })
    }).catch(() => undefined);
  }

  /** Heartbeat de position vers le streamer (throttlé ; recale sur seek). */
  #beat(track: PlexTrack, playing: boolean, currentTimeS: number): void {
    if (!this.reactive || !track.part) return;
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
        key: track.key,
        part: track.part,
        positionMs: Math.round(currentTimeS * 1000),
        playing
      })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((st: { ready?: boolean; analyzing?: boolean } | null) => {
        if (!st) return;
        this.analyzing = st.analyzing === true;
        if (st.ready === true) this.ensureTimeline(track.key);
        // Analyse échouée (ni prêt ni en cours, 2 heartbeats de suite) : plutôt
        // qu'un effet audio sans données (= ruban noir), on retombe sur le
        // fondu « ambiance » pour CETTE piste — le style choisi reste acquis.
        if (st.ready === true || st.analyzing === true) {
          this.#notReadyCount = 0;
        } else if (++this.#notReadyCount >= 2 && !this.#fellBack) {
          this.#fellBack = true;
          if (this.colors) {
            void wled.applyMusicColors(this.colors, this.#lastPlaying ?? true);
          }
        }
      })
      .catch(() => undefined);
  }

  /**
   * À appeler quand piste, lecture ou position changent (depuis un $effect du
   * layout). Idempotent : ignore tout tant que rien n'a changé.
   */
  sync(track: PlexTrack | null, playing: boolean, currentTimeS = 0): void {
    if (!this.enabled) return;

    // File de lecture vidée (croix du mini-player) : on FIGE le ruban sur la
    // dominante (comme une pause) au lieu de laisser l'effet tourner sans fin.
    if (!track) {
      if (this.#lastTrackKey !== null && this.#lastPlaying !== false) {
        this.#lastPlaying = false;
        void wled.setMusicPaused(true);
        this.#stopStream();
      }
      return;
    }

    if (track.key !== this.#lastTrackKey) {
      this.#lastTrackKey = track.key;
      this.#lastPlaying = playing;
      this.#lastBeatAt = 0; // heartbeat immédiat (lance l'analyse au besoin)
      this.#notReadyCount = 0;
      this.#fellBack = false;
      // La timeline de l'ancienne piste ne doit pas animer la nouvelle.
      this.liveTimeline = null;
      this.#timelineFor = null;
      const gen = ++this.#gen;
      const art = plexImg(track.thumb, 128);
      if (art) {
        void extractArtworkColors(art, 3).then(async (cols) => {
          if (gen !== this.#gen || !this.enabled) return; // piste déjà remplacée
          this.colors = cols;
          // Le store wled n'est peuplé que si une page l'a connecté (acquire sur
          // /pieces) — or la musique se lance depuis n'importe quelle page. On
          // charge le catalogue + les segments à la demande.
          if (!wled.segments.length || !wled.effects.length) await wled.loadMeta();
          if (gen !== this.#gen || !this.enabled) return;
          void wled.applyMusicColors(cols, this.#lastPlaying ?? playing, this.styleDef);
        });
      }
      this.#beat(track, playing, currentTimeS);
      return;
    }

    if (playing !== this.#lastPlaying) {
      this.#lastPlaying = playing;
      void wled.setMusicPaused(!playing, this.styleDef.fx);
    }
    this.#beat(track, playing, currentTimeS);
  }
}

export const wledMusic = new WledMusicStore();
