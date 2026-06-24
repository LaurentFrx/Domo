/**
 * Tracker de vélocité du doigt pour le pager (px/s), lissé par moyenne
 * exponentielle (EMA). Mesurer la vitesse sur la FIN du geste (~80 ms), pas sur
 * tout le drag (fausse inertie) ni sur le dernier frame (jitter).
 *
 * Spécificités 2 doigts :
 *  - on échantillonne le POINT MILIEU des deux doigts, bruité (les deux capteurs
 *    ne se rafraîchissent pas dans le même frame) → EMA obligatoire ;
 *  - l'appelant NE doit échantillonner QUE quand `touches.length === 2` : la
 *    transition 2→1 doigt en fin de geste ferait sauter le milieu de la moitié de
 *    l'écart inter-doigts → vélocité fantôme → commit accidentel.
 */

export interface VelocityTracker {
  reset(): void;
  /** Ajoute un échantillon (x = milieu des doigts en px, t = performance.now() en ms). */
  sample(x: number, t: number): void;
  /** Vélocité lissée (px/s) ; 0 si le doigt s'est arrêté (> 50 ms sans échantillon). */
  velocity(nowMs: number): number;
}

const TAU = 0.08; // constante de lissage EMA (s)
const MIN_DT = 0.008; // segment < 8 ms : jitter → ignoré
const STALE_MS = 50; // dernier échantillon trop vieux → doigt arrêté

export function createVelocityTracker(): VelocityTracker {
  let ema = 0;
  let lastX = 0;
  let lastT = 0;
  let has = false;

  return {
    reset() {
      ema = 0;
      lastX = 0;
      lastT = 0;
      has = false;
    },
    sample(x, t) {
      if (!has) {
        lastX = x;
        lastT = t;
        has = true;
        return;
      }
      const dt = (t - lastT) / 1000;
      if (dt < MIN_DT) return;
      const inst = (x - lastX) / dt; // px/s instantané
      const alpha = 1 - Math.exp(-dt / TAU);
      ema += alpha * (inst - ema);
      lastX = x;
      lastT = t;
    },
    velocity(nowMs) {
      if (!has) return 0;
      if (nowMs - lastT > STALE_MS) return 0; // doigt immobile avant le lâcher
      return ema;
    }
  };
}
