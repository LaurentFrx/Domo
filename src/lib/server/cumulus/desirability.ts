/**
 * Modèle CONTINU de désirabilité de chauffe du cumulus — « les potentiomètres ».
 *
 * Remplace la logique booléenne à seuils par un modèle d'utilité continu : chaque
 * entrée → signal ∈ [0,1] via smootherstep (S-curve de Perlin, dérivées 1re ET
 * 2de nulles aux bords = Bézier douce, tue les falaises type « 64 % bloque tout »).
 * Les signaux s'assemblent en D ∈ [0,1] qui franchit UN seuil à hystérésis → on/off.
 *
 * VERSION SÛRE PAR CONSTRUCTION (refonte après revue adversariale 23/07) :
 * on ne chauffe QUE sur surplus solaire CONFIRMÉ, batterie déjà bien au-dessus de
 * sa réserve. Trois défauts de la v1 supprimés :
 *  - PAS de « chauffe confort » qui forcerait un import quand la cuve est basse et
 *    qu'il n'y a pas de surplus (= chauffe HP de panique, bannie par Laurent — le
 *    confort est garanti par le PLAN HC nocturne, séparé) ;
 *  - PAS de « voie de prêt » spéculative qui tirerait de la batterie sur la foi
 *    d'une prévision (drainait la réserve du soir) ;
 *  - écrêtage détecté correctement : batterie quasi pleine ET soleil FRANC (via
 *    l'APS, jamais bridé), PAS via la dérivée de charge (nulle quand ça écrête).
 * Résultat : à chaque instant où D est haut, il y a du surplus gratuit ET la
 * batterie est haute (SoC ≳ 85 %) → la chauffe recouvre du PV sinon écrêté sans
 * puiser la réserve. Un veto d'import (D=0 dès qu'on soutire) est le filet ultime.
 * L'hiver s'éteint tout seul (pas de surplus → freeSurplus≈0 → D≈0 → repli HC).
 */

// ─── Primitives de mise en forme (courbes continues) ────────────────────────

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** S-curve de Perlin : 0 en e0, 1 en e1, plate (dérivées 1re ET 2de nulles) aux
 *  bords. Remplaçant continu SANS FALAISE d'un seuil booléen. */
export function smootherstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Rampe DÉCROISSANTE : 1 en e0, 0 en e1. */
const falling = (e0: number, e1: number, x: number): number => 1 - smootherstep(e0, e1, x);

// ─── Contrat d'entrée ───────────────────────────────────────────────────────

export interface DesInputs {
  /** Élévation solaire (°) — éphémérides. */
  sunElevDeg: number;
  /** Production APS EZ1 (W) — l'ÉTALON, JAMAIS bridé : mesure la force réelle du soleil. */
  pvApsW: number;
  /** Énergie thermique stockée (Wh, sur °C-MOYENNE, jamais la sonde). */
  eAvailWh: number;
  /** Énergie cuve pleine (Wh). */
  eFullWh: number;
  /** Réseau signé (W) : + soutirage EDF / − injection. */
  gridPowerW: number;
  /** Charge AC absorbée par la batterie (W ≥ 0) = surplus qui s'y stocke ; null si muet. */
  maxAcChargeW: number | null;
  /** SoC du parc batterie, fraction 0..1. */
  socFrac: number;
  /** Puissance de chauffe (W) — échelle de saturation. */
  heaterW: number;
  /** Un gros appareil (four/plaques/lave-*) tourne → veto cuisine. */
  applianceActive: boolean;
}

export interface DesConfig {
  /** Export (W) où le signal free commence à monter (bas — capte 200 W perdus). */
  exportKneeW: number;
  /** Charge batterie (W) : bornes où elle compte comme surplus fort (≈ couverture heater). */
  chargeKneeLowW: number;
  chargeKneeHighW: number;
  /** SoC où la charge devient du VRAI surplus (au-dessus de la réserve batterie). */
  surplusSocLow: number;
  surplusSocHigh: number;
  /** SoC où l'écrêtage devient probable (batterie quasi pleine). */
  curtailSocLow: number;
  curtailSocHigh: number;
  /** Production APS (W) attestant un soleil FRANC (écrêtage recouvrable). */
  apsStrongLowW: number;
  apsStrongHighW: number;
  /** Fenêtre solaire douce : élévation de début/fin de rampe (°). */
  sunSoftLowDeg: number;
  sunSoftHighDeg: number;
  /** Soutirage EDF (W) au-delà duquel VETO dur (jamais chauffer en important). */
  importVetoW: number;
  /** Hystérésis de sortie sur D. */
  dOn: number;
  dOff: number;
}

export function defaultDesConfig(): DesConfig {
  return {
    exportKneeW: 150,
    chargeKneeLowW: 800,
    chargeKneeHighW: 2200, // charge ≳ 2,2 kW = surplus proche de couvrir le heater
    surplusSocLow: 0.75, // sous 75 % la charge remplit la réserve nécessaire, pas du surplus
    surplusSocHigh: 0.9,
    curtailSocLow: 0.85, // écrêtage : batterie quasi pleine
    curtailSocHigh: 0.95,
    apsStrongLowW: 300, // APS > 300 W = soleil franc (le SB serait bridé si batterie pleine)
    apsStrongHighW: 700,
    sunSoftLowDeg: 12,
    sunSoftHighDeg: 25,
    importVetoW: 120,
    dOn: 0.55,
    dOff: 0.35
  };
}

// ─── Signaux (chacun ∈ [0,1]) ───────────────────────────────────────────────

export interface DesSignals {
  tankRoom: number; // portail de place : ~1 sauf près du plein
  freeExport: number; // don franc au compteur (rare sous zéro-export)
  freeCharge: number; // charge batterie AU-DESSUS de sa réserve (vrai surplus stocké)
  freeCurtail: number; // écrêtage : batterie quasi pleine + soleil franc (APS) → PV recouvrable
  freeSurplus: number; // max des trois = surplus gratuit confirmé
  solarWindow: number; // fenêtre solaire douce (0 la nuit)
}

export function computeSignals(di: DesInputs, cfg: DesConfig): DesSignals {
  // Portail de place — ~1 tant que la cuve a de la place, se ferme dans les 7 %
  // du haut (valeur marginale décroissante uniquement tout près du plein).
  const tankRoom = falling(0.93 * di.eFullWh, 0.99 * di.eFullWh, di.eAvailWh);

  // (a) Export franc = énergie VRAIMENT perdue (0 €, pas de revente). Rare sous
  // la régulation zéro-export de la Max AC, mais toujours valable si présent.
  const exportW = Math.max(0, -di.gridPowerW);
  const freeExport = smootherstep(cfg.exportKneeW, di.heaterW, exportW);

  // (b) Charge batterie comme surplus — SEULEMENT au-dessus de la réserve (SoC ≥
  // ~75 % : une batterie basse qui charge remplit son PROPRE besoin, ce n'est pas
  // du surplus — leçon 23/07) ET si la charge est FORTE (≳ 2 kW ≈ couvre le heater
  // → chauffer ne puise quasi pas la batterie).
  const battIsSurplus = smootherstep(cfg.surplusSocLow, cfg.surplusSocHigh, di.socFrac);
  const chargeMag =
    di.maxAcChargeW === null
      ? 0
      : smootherstep(cfg.chargeKneeLowW, cfg.chargeKneeHighW, di.maxAcChargeW);
  const freeCharge = chargeMag * battIsSurplus;

  // (c) Écrêtage : batterie QUASI PLEINE (ne peut plus absorber) ET soleil FRANC
  // — attesté par l'APS (jamais bridé). Alors les panneaux SolarBank sont bridés :
  // chauffer les « dé-bride » (recouvre du PV sinon perdu), couverture ≈ pleine,
  // ZÉRO puisage batterie. CORRECTION v1 : ne dépend PAS de la dérivée de charge
  // (nulle justement quand la batterie pleine cesse de charger = quand ça écrête).
  const nearFull = smootherstep(cfg.curtailSocLow, cfg.curtailSocHigh, di.socFrac);
  const sunStrong = smootherstep(cfg.apsStrongLowW, cfg.apsStrongHighW, di.pvApsW);
  const freeCurtail = nearFull * sunStrong;

  const freeSurplus = Math.max(freeExport, freeCharge, freeCurtail);

  // Fenêtre solaire douce : ~0 la nuit (élévation < 12°). NB : ne suffit PAS à
  // éteindre l'hiver (élévation midi ~22° → window ~0,9) — c'est l'ABSENCE de
  // surplus (freeSurplus≈0) qui éteint l'hiver, pas la fenêtre. La fenêtre ne
  // fait qu'interdire la nuit.
  const solarWindow = smootherstep(cfg.sunSoftLowDeg, cfg.sunSoftHighDeg, di.sunElevDeg);

  return { tankRoom, freeExport, freeCharge, freeCurtail, freeSurplus, solarWindow };
}

// ─── Assemblage : D ∈ [0,1] ─────────────────────────────────────────────────

export interface DesResult {
  D: number;
  signals: DesSignals;
  reason: string;
}

/**
 * D = fenêtre × place × surplus-confirmé. Trois portails/magnitude :
 *  - solarWindow ferme la nuit ;
 *  - tankRoom ferme cuve pleine ;
 *  - freeSurplus porte la magnitude (surplus gratuit confirmé, batterie haute).
 * VETO DUR d'import : dès qu'on soutire (> importVetoW), D=0 — le ballon ne cause
 * JAMAIS d'achat EDF. VETO cuisine : gros appareil → D=0 (la maison d'abord).
 * PAS de voie confort ni de prêt : la sûreté est STRUCTURELLE (on ne chauffe qu'à
 * SoC élevé sur du surplus réel), pas laissée à une prévision.
 */
export function computeDesirability(di: DesInputs, cfg: DesConfig): DesResult {
  const s = computeSignals(di, cfg);
  let D = s.solarWindow * s.tankRoom * s.freeSurplus;

  const buyW = Math.max(0, di.gridPowerW);
  if (buyW > cfg.importVetoW) D = 0; // veto import : jamais chauffer en soutirant
  if (di.applianceActive) D = 0; // veto cuisine : la maison d'abord

  const reason = di.applianceActive
    ? 'veto cuisine (gros appareil)'
    : buyW > cfg.importVetoW
      ? `veto import (${Math.round(buyW)} W soutirés)`
      : s.solarWindow < 0.05
        ? 'nuit — repli HC'
        : s.tankRoom < 0.05
          ? 'ballon plein'
          : s.freeSurplus < 0.1
            ? 'pas de surplus confirmé — on attend (batterie d’abord)'
            : s.freeCurtail > 0.4
              ? `écrêtage recouvré (batterie pleine + soleil franc ${Math.round(di.pvApsW)} W)`
              : s.freeCharge > 0.4
                ? `charge batterie excédentaire (SoC ${Math.round(di.socFrac * 100)} %)`
                : `don franc au réseau (${Math.round(Math.max(0, -di.gridPowerW))} W)`;

  return { D: clamp01(D), signals: s, reason };
}

/**
 * Sortie on/off à HYSTÉRÉSIS — conversion continu→binaire, tout à la fin.
 * (Les min-on/off/anti-cycle/grâce restent gérés par pilot.ts en aval.)
 */
export function hysteresisOn(D: number, prevOn: boolean, cfg: DesConfig): boolean {
  return prevOn ? D > cfg.dOff : D > cfg.dOn;
}
