/**
 * Fondus enchaînés — logique PURE (pas de DOM, pas de Web Audio ici).
 *
 * Matière première : l'analyse de sonie du PMS. Chaque piste analysée porte
 * (via `includeLoudnessRamps=1`) deux « rampes » décrivant l'enveloppe de
 * sonie aux extrémités du morceau, en paires `dB décalage_s` :
 *   - startRamp : décalages depuis le DÉBUT (montée en puissance de l'intro) ;
 *   - endRamp   : décalages depuis la FIN (décroissance de l'outro).
 * Les dB sont relatifs à la sonie de référence de l'analyse (0 ≈ plein
 * niveau, −51 = silence). C'est la donnée qu'exploite PlexAmp pour ses
 * « fondus intelligents » : un morceau qui s'éteint en long fade-out mérite un
 * fondu ample, une fin sèche un enchaînement court — et un silence d'intro se
 * saute.
 */

/** Un point d'enveloppe : [sonie dB, décalage en secondes]. */
export type RampPoint = [number, number];

/** Analyse d'une piste, servie par GET /api/plex/fade/<key>. */
export interface TrackFadeInfo {
  /** Gain de nivellement (dB, style ReplayGain) — null si non analysé. */
  gain: number | null;
  /** Enveloppe d'intro (décalages depuis le début), dB croissants. */
  startRamp: RampPoint[] | null;
  /** Enveloppe d'outro (décalages depuis la fin), dB croissants. */
  endRamp: RampPoint[] | null;
}

/** Sous ce niveau, l'outro est considérée « éteinte » : le fondu peut couvrir. */
const OUTRO_THRESHOLD_DB = -10;
/** Au-dessus de ce niveau, l'intro est audible (en-deçà : silence de tête). */
const INTRO_THRESHOLD_DB = -25;
/** Nivellement : gain par défaut quand la piste n'a pas d'analyse (dB). */
const LEVEL_FALLBACK_DB = -6;
/** Nivellement : gain positif plafonné (éviter l'écrêtage numérique). */
const LEVEL_MAX_DB = 3;

/** Parse une rampe PMS (`"-51.00 0.00;-25.42 0.90;…"`) en points valides. */
export function parseRamp(raw: unknown): RampPoint[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  const pts: RampPoint[] = [];
  for (const chunk of raw.split(';')) {
    const t = chunk.trim();
    if (!t) continue;
    const [db, s] = t.split(/\s+/).map(Number);
    if (Number.isFinite(db) && Number.isFinite(s) && s >= 0) pts.push([db, s]);
  }
  return pts.length >= 2 ? pts : null;
}

/**
 * Abscisse (en secondes) où l'enveloppe croise `threshold` dB, interpolée
 * entre les deux points qui l'encadrent. Les rampes PMS sont ordonnées dB
 * croissants — le premier point au-dessus du seuil borne la traversée.
 */
function crossingS(ramp: RampPoint[], threshold: number): number | null {
  const i = ramp.findIndex(([db]) => db >= threshold);
  if (i < 0) return ramp[ramp.length - 1][1]; // jamais au-dessus : tout est sous le seuil
  if (i === 0) return ramp[0][1]; // déjà au-dessus au premier point
  const [db0, s0] = ramp[i - 1];
  const [db1, s1] = ramp[i];
  if (db1 === db0) return s1;
  return s0 + ((threshold - db0) / (db1 - db0)) * (s1 - s0);
}

/**
 * Longueur « naturelle » du fade-out (secondes avant la fin où l'outro passe
 * sous le seuil). Fin sèche → ~0 (le fondu sera court, la fin ne sera pas
 * amputée) ; long fade-out → plusieurs secondes à couvrir.
 */
export function outroLeadS(endRamp: RampPoint[]): number {
  return crossingS(endRamp, OUTRO_THRESHOLD_DB) ?? 0;
}

/** Durée du silence de tête (secondes avant que l'intro soit audible). */
export function introSilenceS(startRamp: RampPoint[]): number {
  return crossingS(startRamp, INTRO_THRESHOLD_DB) ?? 0;
}

/** Multiplicateur linéaire du nivellement de volume (gain dB → facteur). */
export function levelFrom(gainDb: number | null): number {
  const db = Math.min(gainDb ?? LEVEL_FALLBACK_DB, LEVEL_MAX_DB);
  return Math.pow(10, db / 20);
}

/**
 * Courbe de fondu à PUISSANCE CONSTANTE (sin/cos) pour setValueCurveAtTime :
 * la somme des puissances des deux platines reste ~1 pendant tout le fondu —
 * un fondu linéaire creuse un « trou » de volume au milieu. `level` met la
 * courbe à l'échelle du nivellement de la piste.
 */
export function equalPowerCurve(dir: 'in' | 'out', level: number, n = 33): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (Math.PI / 2);
    c[i] = (dir === 'in' ? Math.sin(x) : Math.cos(x)) * level;
  }
  return c;
}
