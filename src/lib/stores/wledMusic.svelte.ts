/**
 * Suivi de la musique par l'éclairage terrasse.
 *
 * Quand le mode est actif, la terrasse « écoute » le lecteur Plex de l'app :
 *   - nouveau morceau  → couleurs dominantes de la pochette appliquées au ruban
 *     (3 slots WLED + palette dégradé + effet fluide) ;
 *   - pause / reprise  → couleur dominante fixe / reprise de l'effet.
 *
 * Le pilotage part de L'APPAREIL où la musique joue (le lecteur est local à
 * l'app) — si deux appareils jouent avec le mode actif, le dernier événement
 * gagne : cas marginal assumé. La préférence est persistée par appareil.
 *
 * Branchement : `sync()` est appelé depuis un $effect du layout (toujours
 * monté) qui lit `player.current` / `player.playing` — pas de $effect.root ici.
 */

import { wled } from '$stores/wled.svelte';
import { plexImg, type PlexTrack } from '$stores/plex.svelte';
import { extractArtworkColors } from '$utils/artwork-colors';
import type { RGB } from '$stores/wled.svelte';

const LS_KEY = 'domo.wled.music';

class WledMusicStore {
  enabled = $state(false);
  /** Couleurs du morceau en cours (pastille de la chip « Musique »). */
  colors = $state<RGB[] | null>(null);

  #lastTrackKey: string | null = null;
  #lastPlaying: boolean | null = null;
  /** Jeton anti-course : seule la dernière extraction lancée a le droit d'écrire. */
  #gen = 0;

  constructor() {
    if (typeof localStorage !== 'undefined') {
      try {
        this.enabled = localStorage.getItem(LS_KEY) === '1';
      } catch {
        /* localStorage indisponible : préférence non restaurée */
      }
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(LS_KEY, on ? '1' : '0');
    } catch {
      /* perte acceptée */
    }
    if (!on) {
      // On rend la main SANS toucher au ruban : il garde ses couleurs actuelles.
      this.#lastTrackKey = null;
      this.#lastPlaying = null;
    }
  }

  /** Un réglage manuel (ambiance, couleur, effet) reprend la main. */
  releaseControl(): void {
    if (this.enabled) this.setEnabled(false);
  }

  /**
   * À appeler quand piste ou lecture changent (depuis un $effect du layout).
   * Idempotent : ignore tout tant que rien n'a changé.
   */
  sync(track: PlexTrack | null, playing: boolean): void {
    if (!this.enabled) return;

    // File de lecture vidée (croix du mini-player) : on FIGE le ruban sur la
    // dominante (comme une pause) au lieu de laisser l'effet tourner sans fin.
    if (!track) {
      if (this.#lastTrackKey !== null && this.#lastPlaying !== false) {
        this.#lastPlaying = false;
        void wled.setMusicPaused(true);
      }
      return;
    }

    if (track.key !== this.#lastTrackKey) {
      this.#lastTrackKey = track.key;
      this.#lastPlaying = playing;
      const gen = ++this.#gen;
      const art = plexImg(track.thumb, 128);
      if (!art) return;
      void extractArtworkColors(art, 3).then(async (cols) => {
        if (gen !== this.#gen || !this.enabled) return; // piste déjà remplacée
        this.colors = cols;
        // Le store wled n'est peuplé que si une page l'a connecté (acquire sur
        // /pieces) — or la musique se lance depuis n'importe quelle page. On
        // charge le catalogue + les segments à la demande.
        if (!wled.segments.length || !wled.effects.length) await wled.loadMeta();
        if (gen !== this.#gen || !this.enabled) return;
        void wled.applyMusicColors(cols, this.#lastPlaying ?? playing);
      });
      return;
    }

    if (playing !== this.#lastPlaying) {
      this.#lastPlaying = playing;
      void wled.setMusicPaused(!playing);
    }
  }
}

export const wledMusic = new WledMusicStore();
