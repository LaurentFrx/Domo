/**
 * Estimateur de POTENTIEL solaire — la réponse au « surplus invisible ».
 *
 * Problème (mesuré le 02/07) : batteries pleines → les stations Anker brident
 * leurs panneaux au strict besoin de la maison → leur production AFFICHÉE devient
 * mensongère (100 W affichés, 2500 W possibles). Le surplus part au réseau ou est
 * écrêté, invisible.
 *
 * Principe (spec Laurent) : les 2×585 Wc de l'onduleur APS (Sud 190°/20°) sont
 * IDENTIQUES et ADJACENTS aux 2×585 Wc de la station SB1. L'APS n'est JAMAIS bridé
 * (il injecte toujours son maximum) → sa production est l'étalon du potentiel vrai :
 *
 *   potentiel SB1 ≈ P_APS × kSB1                     (kSB1 ≈ 1, calibré en continu)
 *   potentiel SB2 ≈ P_APS × (1000/1170) × fOuest     (2×500 Wc orientés Ouest)
 *     avec fOuest = ratio_géométrique(soleil) × correction_apprise(mois, heure)
 *
 * Le ratio géométrique vient des éphémérides (sun.ts : incidence Ouest / incidence
 * Sud) — il donne la FORME de la journée ; la correction apprise absorbe les masques
 * réels (mur de 6 m le matin, toit voisin le soir en été). La calibration ne se fait
 * QUE quand les batteries ne sont PAS pleines (la production affichée y est vraie),
 * par moyenne glissante exponentielle, persistée dans data/solar-potential.json
 * (fichier de DONNÉES apprises — pas de la configuration).
 *
 * SURPLUS INVISIBLE = (potentiel SB1 + potentiel SB2) − production affichée Anker,
 * quand les batteries sont pleines. C'est l'énergie en train d'être perdue.
 */

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../atomic-store';
import { sunPosition, planeIncidenceCos } from './sun.ts';

const FILE = path.join(path.resolve(process.cwd(), 'data'), 'solar-potential.json');

// Géométrie de l'installation (fiche docs/installation-energie.md)
const SUD_AZ = 190; // pan Sud : azimut 190°, inclinaison 20°
const SUD_TILT = 20;
const OUEST_AZ = 270; // pan Ouest (2×500 Wc sur SB2)
const OUEST_TILT = 20;
const RATIO_WC_SB2 = 1000 / 1170; // 2×500 Wc vs 2×585 Wc

const EWMA_ALPHA = 0.05; // lissage des calibrations (~20 échantillons de mémoire)
const CALIB_MIN_APS_W = 150; // en dessous, le signal étalon est trop faible pour calibrer

/** Données apprises, persistées (PAS de la config — un état qui s'affine). */
export interface SolarCalib {
  kSB1: number; // rapport SB1/APS appris (départ 1.0)
  /** Correction Ouest apprise, par mois (1-12) puis heure locale (0-23). */
  cWest: Record<string, Record<string, number>>;
  samples: number; // nombre total de calibrations (diagnostic)
  updatedAt: number;
}

export function defaultSolarCalib(): SolarCalib {
  return { kSB1: 1.0, cWest: {}, samples: 0, updatedAt: 0 };
}

function normalizeSolarCalib(raw: unknown): SolarCalib {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultSolarCalib();
  const kSB1 =
    typeof o.kSB1 === 'number' && Number.isFinite(o.kSB1)
      ? Math.min(1.5, Math.max(0.5, o.kSB1))
      : d.kSB1;
  const cWest: SolarCalib['cWest'] = {};
  if (o.cWest && typeof o.cWest === 'object') {
    for (const [m, hours] of Object.entries(o.cWest as Record<string, unknown>)) {
      if (!hours || typeof hours !== 'object') continue;
      cWest[m] = {};
      for (const [h, v] of Object.entries(hours as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          cWest[m][h] = Math.min(2, Math.max(0.1, v));
        }
      }
    }
  }
  return {
    kSB1,
    cWest,
    samples: typeof o.samples === 'number' ? o.samples : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0
  };
}

export async function readSolarCalib(): Promise<SolarCalib> {
  return readJsonSafe(FILE, {
    fallback: defaultSolarCalib,
    normalize: normalizeSolarCalib,
    label: 'solar-potential.json'
  });
}

export async function writeSolarCalib(calib: SolarCalib): Promise<void> {
  await writeJsonAtomic(FILE, normalizeSolarCalib(calib));
}

export interface PotentialInput {
  ts: number; // epoch ms
  monthLocal: number; // mois local Paris (1-12)
  hourLocal: number; // heure locale Paris (0-23, entière)
  pApsW: number; // production APS instantanée (l'étalon, jamais bridé)
  sb1InW: number | null; // PV entrant station Sud (input_power_w) — null si indispo
  sb2InW: number | null; // PV entrant station Ouest — null si indispo
  pvShownW: number; // production totale AFFICHÉE par Anker (mensongère en bridage)
  batteriesFull: boolean; // bridage probable → la prod affichée MENT, ne pas calibrer
}

export interface PotentialResult {
  potSb1W: number;
  potSb2W: number;
  /** Potentiel total instantané = APS + SB1 + SB2 (ce que les panneaux PEUVENT donner). */
  potTotalW: number;
  /** Énergie en train d'être perdue (bridage) : potentiel stations − affiché. 0 hors bridage. */
  invisibleSurplusW: number;
  geoRatioWest: number; // ratio géométrique brut (diagnostic)
  calibUpdated: boolean; // une calibration a eu lieu ce tick (→ persister)
}

/**
 * Estime le potentiel instantané et, si les conditions le permettent, affine la
 * calibration (mutation de `calib` — l'appelant persiste si `calibUpdated`).
 */
export function estimatePotential(
  input: PotentialInput,
  latDeg: number,
  lonDeg: number,
  calib: SolarCalib
): PotentialResult {
  const { pApsW, sb1InW, sb2InW, pvShownW, batteriesFull, monthLocal, hourLocal } = input;

  // Géométrie du moment : incidence sur chaque plan
  const sun = sunPosition(input.ts, latDeg, lonDeg);
  const incSud = planeIncidenceCos(sun, SUD_TILT, SUD_AZ);
  const incOuest = planeIncidenceCos(sun, OUEST_TILT, OUEST_AZ);
  const geoRatioWest = incSud > 0.05 ? Math.min(1.6, incOuest / incSud) : 0;

  const mKey = String(monthLocal);
  const hKey = String(hourLocal);
  const cWest = calib.cWest[mKey]?.[hKey] ?? 1.0;

  const potSb1W = Math.max(0, pApsW * calib.kSB1);
  const potSb2W = Math.max(0, pApsW * RATIO_WC_SB2 * geoRatioWest * cWest);
  const potTotalW = Math.round(pApsW + potSb1W + potSb2W);

  // Surplus invisible : uniquement en bridage (hors bridage, l'affiché est vrai).
  const invisibleSurplusW = batteriesFull
    ? Math.max(0, Math.round(potSb1W + potSb2W - Math.max(0, pvShownW)))
    : 0;

  // ── Calibration : SEULEMENT quand la production affichée est VRAIE ──
  let calibUpdated = false;
  if (!batteriesFull && pApsW >= CALIB_MIN_APS_W) {
    if (sb1InW !== null && sb1InW > 50) {
      const obs = Math.min(1.5, Math.max(0.5, sb1InW / pApsW));
      calib.kSB1 = +(calib.kSB1 + EWMA_ALPHA * (obs - calib.kSB1)).toFixed(4);
      calibUpdated = true;
    }
    if (sb2InW !== null && geoRatioWest > 0.1) {
      const expected = pApsW * RATIO_WC_SB2 * geoRatioWest;
      if (expected > 50) {
        const obs = Math.min(2, Math.max(0.1, sb2InW / expected));
        if (!calib.cWest[mKey]) calib.cWest[mKey] = {};
        const prev = calib.cWest[mKey][hKey] ?? 1.0;
        calib.cWest[mKey][hKey] = +(prev + EWMA_ALPHA * (obs - prev)).toFixed(4);
        calibUpdated = true;
      }
    }
    if (calibUpdated) {
      calib.samples += 1;
      calib.updatedAt = input.ts;
    }
  }

  return {
    potSb1W: Math.round(potSb1W),
    potSb2W: Math.round(potSb2W),
    potTotalW,
    invisibleSurplusW,
    geoRatioWest: +geoRatioWest.toFixed(3),
    calibUpdated
  };
}
