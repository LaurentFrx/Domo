/**
 * Intégrateur de ressort masse-ressort-amortisseur, paramétré « façon SwiftUI »
 * (`response` + `dampingFraction`), pour piloter une transition de page avec la
 * fluidité d'iOS : pas de durée figée, la VITESSE initiale (du doigt) est portée
 * en continu, et l'animation est INTERRUPTIBLE (on lit `x`/`v` à tout instant).
 *
 * Intégration semi-implicite (Euler symplectique) à PAS DE TEMPS FIXE (1/60 s) via
 * un accumulateur : trajectoire identique à 60 Hz (iPhone) et 120 Hz (iPad ProMotion).
 * Sans ça, le ressort irait deux fois plus vite à 120 Hz.
 *
 * `x` est sans dimension (progression `p`, typiquement 0→1) ; le `restDelta` est
 * donc adaptatif côté appelant (≈ 0,5 px / largeur) pour s'arrêter au demi-pixel.
 *
 * Réf. : SwiftUI `.spring(response:dampingFraction:)`, UISpringTimingParameters,
 * Framer Motion (type:'spring' + velocity). omega = 2π/response ; k = omega²·m ;
 * c = 2·damping·√(k·m).
 */

export interface SpringOpts {
  /** Période naturelle (s) — « rapidité perçue ». iOS interactif ≈ 0.25. */
  response: number;
  /** Fraction d'amortissement. 1 = critique (pas de rebond) ; page ≈ 0.86. */
  damping: number;
  /** Masse (référence 1). */
  mass?: number;
}

export interface Spring {
  /** Position courante (progression sans dimension). */
  readonly x: number;
  /** Vitesse courante (unités de x par seconde). */
  readonly v: number;
  /** Cible courante. */
  readonly target: number;
  /** Seuil d'arrêt en position (adaptatif, à régler ≈ 0,5/largeur). */
  restDelta: number;
  /** Définit la cible sans toucher à la position/vitesse (déclenche le mouvement). */
  setTarget(t: number): void;
  /** Injecte une vitesse initiale (px/s convertis en x/s par l'appelant). */
  seed(velocity: number): void;
  /** Saute instantanément à `t` (vitesse nulle) — reduced-motion / filet. */
  snap(t: number): void;
  /** Repositionne sans animer (reprise interactive : on prend la main sur x). */
  setPosition(x: number): void;
  /** Avance la simulation de `dtMs` (clampé 64 ms). Retourne false quand au repos. */
  tick(dtMs: number): boolean;
}

const REST_SPEED = 0.02; // |v| en dessous duquel on peut s'arrêter
const MAX_DT_MS = 64; // clamp (retour d'arrière-plan, onglet gelé)
const H = 1 / 60; // pas d'intégration fixe (s)

export function createSpring(opts: SpringOpts): Spring {
  const m = opts.mass ?? 1;
  const omega = (2 * Math.PI) / opts.response;
  const k = omega * omega * m;
  const c = 2 * opts.damping * Math.sqrt(k * m);

  let x = 0;
  let v = 0;
  let target = 0;
  let acc = 0;

  return {
    get x() {
      return x;
    },
    get v() {
      return v;
    },
    get target() {
      return target;
    },
    restDelta: 0.001,
    setTarget(t) {
      target = t;
    },
    seed(velocity) {
      v = velocity;
    },
    snap(t) {
      x = t;
      target = t;
      v = 0;
      acc = 0;
    },
    setPosition(nx) {
      x = nx;
      acc = 0;
    },
    tick(dtMs) {
      acc += Math.min(dtMs, MAX_DT_MS) / 1000;
      while (acc >= H) {
        const a = (-k * (x - target) - c * v) / m;
        v += a * H; // vitesse AVANT position (symplectique → stable)
        x += v * H;
        acc -= H;
      }
      if (Math.abs(v) < REST_SPEED && Math.abs(x - target) < this.restDelta) {
        x = target;
        v = 0;
        acc = 0;
        return false;
      }
      return true;
    }
  };
}
