/**
 * Calibration APPRISE de la relaxation post-plein de la sonde ballon (04/07/2026).
 *
 * Phénomène (confirmé sur données réelles, maison vide, aucun tirage possible) :
 * pendant la chauffe, la résistance chauffe le doigt de gant par conduction → la
 * sonde SURLIT la température réelle. Après la coupure thermostat : (a) le fourreau
 * se rééquilibre avec l'eau du fond (chute de quelques °C SANS perte d'énergie du
 * ballon), (b) la stratification se recreuse (fin du brassage, la couche froide
 * retombe au fond où est la sonde). Sur ~1-3 h la sonde chute plus vite que les
 * pertes réelles → sans ce terme, le détecteur de puisage (energy-model.ts) déclenche
 * un FAUX puisage (constaté le 04/07 à 16:47, marge de seulement 0,077°C au-dessus
 * du seuil — et systématique : les 7 derniers pleins isolés depuis le 29/06 ont TOUS
 * fini par franchir le seuil, entre 21 et 117 min après le pic).
 *
 * Amplitude/tau de départ CALIBRÉS (pas supposés) sur le seul cas confirmé sans
 * aucune ambiguïté (04/07, ~3h33 de relaxation propre observée depuis le pic 59,8°C
 * à 15h16) : chute totale 4,28°C dont ~0,77°C expliqués par les pertes lossCoeff
 * (le reste, ~3,5°C, est l'artefact). Un seul échantillon de cette durée ne permet
 * PAS de séparer amplitude et tau avec certitude si tau est long (la courbe reste
 * quasi linéaire sur toute la fenêtre observée) : tau=120 min est un choix
 * physiquement raisonnable (durée de la « zone à risque » observée sur les 7 cas
 * historiques, tous déclenchés avant 117 min), avec l'amplitude ajustée dessus
 * (A=6°C). Vérifié par simulation rétrospective sur les 7 pleins : élimine le
 * déclenchement sur le cas confirmé et sur la plupart des autres, tout en laissant
 * détecter le seul cas qui s'avère être un VRAI puisage (30/06 16h00 : chute de
 * 13°C en 20 min après un préambule de 18 min ressemblant à de la relaxation).
 *
 * Auto-recalage : à chaque fenêtre de relaxation PROPRE achevée (pic → nouveau pic,
 * sans puisage détecté entre les deux — `energy.cleanSinceRef`), la valeur finale
 * observée met à jour amplitude ET tau par EWMA lente, bornée. Persisté ici (PAS
 * dans config.ts : c'est de l'APPRIS, pas du réglé — même principe que
 * solar-potential.ts pour la calibration Sud→Ouest).
 */

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../atomic-store.ts';

const FILE = path.join(path.resolve(process.cwd(), 'data'), 'probe-relax.json');

const AMPLITUDE_MIN = 0;
const AMPLITUDE_MAX = 8; // borne mission
const TAU_MIN = 20;
const TAU_MAX = 240; // bornes mission
const EWMA_ALPHA = 0.15; // mise à jour rare (1-2 pleins propres/jour) → peut être plus réactive que solar-potential

export interface ProbeRelaxCalib {
  amplitudeC: number; // A : amplitude totale typique de la relaxation (°C)
  tauMin: number; // constante de temps (minutes)
  samples: number; // nombre de fenêtres propres ayant contribué (diagnostic)
  updatedAt: number;
}

/** Valeurs de départ CALIBRÉES sur le cas confirmé du 04/07 (voir docstring). */
export function defaultProbeRelaxCalib(): ProbeRelaxCalib {
  return { amplitudeC: 6, tauMin: 120, samples: 0, updatedAt: 0 };
}

function normalizeProbeRelaxCalib(raw: unknown): ProbeRelaxCalib {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultProbeRelaxCalib();
  const amplitudeC =
    typeof o.amplitudeC === 'number' && Number.isFinite(o.amplitudeC)
      ? Math.min(AMPLITUDE_MAX, Math.max(AMPLITUDE_MIN, o.amplitudeC))
      : d.amplitudeC;
  const tauMin =
    typeof o.tauMin === 'number' && Number.isFinite(o.tauMin)
      ? Math.min(TAU_MAX, Math.max(TAU_MIN, o.tauMin))
      : d.tauMin;
  return {
    amplitudeC,
    tauMin,
    samples: typeof o.samples === 'number' && Number.isFinite(o.samples) ? o.samples : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0
  };
}

export async function readProbeRelaxCalib(): Promise<ProbeRelaxCalib> {
  return readJsonSafe(FILE, {
    fallback: defaultProbeRelaxCalib,
    normalize: normalizeProbeRelaxCalib,
    label: 'probe-relax.json'
  });
}

export async function writeProbeRelaxCalib(calib: ProbeRelaxCalib): Promise<void> {
  await writeJsonAtomic(FILE, normalizeProbeRelaxCalib(calib));
}

/** Valeur cumulée attendue du modèle à l'instant t (minutes depuis le pic). */
export function relaxExpectedC(tMin: number, calib: ProbeRelaxCalib): number {
  if (tMin <= 0) return 0;
  return calib.amplitudeC * (1 - Math.exp(-tMin / calib.tauMin));
}

/**
 * Recale amplitude et tau (EWMA, bornée) à partir d'UNE fenêtre de relaxation
 * PROPRE achevée (aucun puisage détecté depuis le pic). Mute `calib` en place
 * (même contrat que solar-potential.ts : l'appelant persiste si `true` est rendu).
 * Ignore les fenêtres trop courtes (< 30 min, signal insuffisant pour être informatif).
 */
export function updateProbeRelaxCalib(
  tFinalMin: number,
  relaxObservedC: number,
  calib: ProbeRelaxCalib,
  now: number
): boolean {
  if (tFinalMin < 30 || relaxObservedC <= 0) return false;

  const impliedA = relaxObservedC / Math.max(0.05, 1 - Math.exp(-tFinalMin / calib.tauMin));
  const newA = Math.min(
    AMPLITUDE_MAX,
    Math.max(AMPLITUDE_MIN, calib.amplitudeC + EWMA_ALPHA * (impliedA - calib.amplitudeC))
  );

  // tau : résolu analytiquement à partir du point final observé et de l'amplitude
  // COURANTE (avant mise à jour, pour ne pas coupler les deux dans la même passe).
  const ratio = Math.min(0.95, Math.max(0.01, relaxObservedC / calib.amplitudeC));
  const impliedTau = -tFinalMin / Math.log(1 - ratio);
  const newTau = Math.min(
    TAU_MAX,
    Math.max(TAU_MIN, calib.tauMin + EWMA_ALPHA * (impliedTau - calib.tauMin))
  );

  calib.amplitudeC = +newA.toFixed(3);
  calib.tauMin = +newTau.toFixed(1);
  calib.samples += 1;
  calib.updatedAt = now;
  return true;
}
