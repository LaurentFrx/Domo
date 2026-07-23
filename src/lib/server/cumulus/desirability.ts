/**
 * Modèle CONTINU de désirabilité de chauffe du cumulus — « les potentiomètres ».
 *
 * Remplace la logique booléenne à seuils par un modèle d'utilité continu : chaque
 * entrée → signal ∈ [0,1] via smootherstep (S-curve de Perlin, dérivées 1re ET
 * 2de nulles aux bords = Bézier douce, tue les falaises type « 64 % bloque tout »).
 * Les signaux s'assemblent en D ∈ [0,1] qui franchit UN seuil à hystérésis → on/off.
 *
 * VERSION SÛRE PAR CONSTRUCTION (2e refonte, après DEUX revues adversariales) :
 * on ne chauffe QUE sur du surplus solaire RÉELLEMENT gratuit — celui qui, sinon,
 * serait perdu (export franc au compteur, ou PV écrêté quand la batterie NE PEUT
 * PLUS l'absorber). Toute la sûreté est STRUCTURELLE, pas confiée à une prévision.
 *
 * Trois enseignements des revues, gravés ici :
 *  1. « batterie qui charge » ≠ « écrêtage ». Un pack qui absorbe encore du courant
 *     N'écrête PAS : chauffer lui volerait sa charge (puisage réserve, INVISIBLE au
 *     veto sous zéro-export où la Max AC décharge pour tenir le compteur à ~0).
 *     L'écrêtage n'est PROUVÉ que si le pack le MOINS plein du parc est déjà plein
 *     (socFloorFrac, pas la moyenne — sinon la Max AC pleine masque un SB3 encore en
 *     charge) ET la Max AC a cessé d'absorber (maxAcChargeW → 0, mesuré au Modbus) ET
 *     le soleil est franc (APS). Alors chauffer recouvre du PV sinon écrêté ; le
 *     puisage résiduel est BORNÉ par le plancher socFloorFrac (freeCurtail s'éteint
 *     dès qu'un pack repasse sous ~95 %) et refait par le même PV — pas littéralement
 *     zéro, mais un petit transitoire de tête de bande (mesuré ≤ 0,23 kWh/j, jamais
 *     un import : le veto grid reste le filet).
 *  2. Charger < chauffer = puiser la réserve. freeCharge n'est un vrai surplus que si
 *     la charge DÉPASSE la puissance de chauffe (sinon la différence sort de la
 *     batterie). Le parc réel plafonne ~2 kW < heater 2,9 kW → ce signal est ~0 en
 *     pratique, ce qui est CORRECT.
 *  3. Un compteur réseau muet n'est pas « zéro import » : c'est « import inconnu ».
 *     Sans mesure EM-50 fiable, on REFUSE d'allumer (comme le pilote booléen).
 *
 * Aucune prévision, aucune voie de « prêt » ni de « confort » : le confort est
 * garanti par le PLAN HC nocturne, séparé. L'hiver s'éteint tout seul (pas de
 * surplus → freeSurplus≈0 → D≈0 → repli HC).
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
  /** Réseau signé (W) : + soutirage EDF / − injection. Valide SEULEMENT si em50Available. */
  gridPowerW: number;
  /** Le compteur EM-50 répond-il ? Faux ⇒ gridPowerW n'est PAS fiable ⇒ refus d'allumer. */
  em50Available: boolean;
  /** Charge AC absorbée par la batterie (W ≥ 0) = ce qu'elle stocke encore ; null si muet. */
  maxAcChargeW: number | null;
  /** SoC MOYEN du parc batterie, fraction 0..1 (surplus de charge, affichage). */
  socFrac: number;
  /** SoC du pack le MOINS plein, fraction 0..1 — gate d'écrêtage : le parc n'écrête
   *  que si AUCUN pack ne peut plus absorber (évite « Max AC pleine masque un SB3 bas »). */
  socFloorFrac: number;
  /** Puissance de chauffe (W) — échelle de saturation. */
  heaterW: number;
  /** Un gros appareil (four/plaques/lave-*) tourne → veto cuisine. */
  applianceActive: boolean;
}

export interface DesConfig {
  /** Export (W) où le signal free commence à monter (bas — capte 200 W perdus). */
  exportKneeW: number;
  /** Charge batterie (W) : bornes où elle compte comme VRAI surplus. Doivent
   *  ENCADRER le heater : charger sous le heater puise la réserve, pas un surplus. */
  chargeSurplusLowW: number;
  chargeSurplusHighW: number;
  /** SoC où la charge devient du surplus (au-dessus de la réserve batterie). */
  surplusSocLow: number;
  surplusSocHigh: number;
  /** SoC où la batterie est VRAIMENT pleine (écrêtage possible) — proche de battFullPct. */
  curtailSocLow: number;
  curtailSocHigh: number;
  /** Charge (W) sous laquelle la batterie est réputée avoir CESSÉ d'absorber
   *  (preuve directe d'écrêtage : elle ne peut plus rien stocker). */
  chargeExhaustLowW: number;
  chargeExhaustHighW: number;
  /** Production APS (W) attestant un soleil FRANC (donc du PV réellement à recouvrer). */
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
    // Encadre le heater 2,9 kW : sous 2,9 kW la charge ne « couvre » pas la chauffe
    // → chauffer puiserait la différence dans la batterie. Le parc réel (~2 kW) ne
    // franchit jamais ce seuil → freeCharge ≈ 0 en pratique (CORRECT, cf. §2).
    chargeSurplusLowW: 2900,
    chargeSurplusHighW: 3500,
    surplusSocLow: 0.75,
    surplusSocHigh: 0.9,
    // Écrêtage : batterie VRAIMENT pleine (pas 85 %) — aligné sur pilot.battFullPct=98.
    curtailSocLow: 0.95,
    curtailSocHigh: 0.99,
    // La batterie a cessé d'absorber : charge quasi nulle = elle ne peut plus stocker.
    chargeExhaustLowW: 200,
    chargeExhaustHighW: 600,
    apsStrongLowW: 350, // APS > 350 W = soleil franc → du PV réel à recouvrer
    apsStrongHighW: 800,
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
  freeCharge: number; // charge batterie qui DÉPASSE le heater (≈0 sur le parc réel)
  freeCurtail: number; // écrêtage PROUVÉ : batterie pleine + a cessé d'absorber + soleil franc
  freeSurplus: number; // max des trois = surplus gratuit confirmé
  solarWindow: number; // fenêtre solaire douce (0 la nuit)
}

export function computeSignals(di: DesInputs, cfg: DesConfig): DesSignals {
  // Portail de place — ~1 tant que la cuve a de la place, se ferme dans les 7 %
  // du haut (valeur marginale décroissante uniquement tout près du plein).
  const tankRoom = falling(0.93 * di.eFullWh, 0.99 * di.eFullWh, di.eAvailWh);

  // (a) Export franc = énergie VRAIMENT perdue (0 €, pas de revente). Rare sous la
  // régulation zéro-export de la Max AC, mais toujours valable si présent.
  const exportW = Math.max(0, -di.gridPowerW);
  const freeExport = smootherstep(cfg.exportKneeW, di.heaterW, exportW);

  // (b) Charge batterie comme surplus — SEULEMENT au-dessus de la réserve (SoC ≥
  // ~75 %) ET si la charge DÉPASSE le heater (sinon chauffer sort la différence de
  // la batterie = puisage réserve invisible au veto). Le parc réel plafonne ~2 kW
  // < heater 2,9 kW → ce signal reste ~0, ce qui est physiquement CORRECT.
  const battIsSurplus = smootherstep(cfg.surplusSocLow, cfg.surplusSocHigh, di.socFrac);
  const chargeMag =
    di.maxAcChargeW === null
      ? 0
      : smootherstep(cfg.chargeSurplusLowW, cfg.chargeSurplusHighW, di.maxAcChargeW);
  const freeCharge = chargeMag * battIsSurplus;

  // (c) ÉCRÊTAGE PROUVÉ — le gisement dominant l'été. TROIS preuves simultanées :
  //  - le pack le MOINS plein est déjà plein (nearFull sur socFloorFrac, PAS la
  //    moyenne : sinon la Max AC pleine à 100 % tire la moyenne au-dessus du seuil
  //    pendant qu'un SB3 à 96 % absorbe encore → faux écrêtage, revue 24/07) ;
  //  - la Max AC a CESSÉ d'absorber (chargeExhausted : maxAcChargeW → 0, mesuré au
  //    Modbus) ; un pack qui charge encore n'écrête PAS ;
  //  - soleil FRANC (sunStrong via l'APS, jamais bridé) → il y a bien du PV bridé
  //    à recouvrer.
  // Alors chauffer « dé-bride » les panneaux (recouvre du PV sinon perdu) ; le
  // puisage résiduel est BORNÉ par le plancher nearFull et refait du même PV (petit
  // transitoire, ≤ 0,23 kWh/j mesuré ; le veto grid reste le filet anti-import). Max
  // AC muette (maxAcChargeW null) → écrêtage non prouvable → 0.
  const nearFull = smootherstep(cfg.curtailSocLow, cfg.curtailSocHigh, di.socFloorFrac);
  const chargeExhausted =
    di.maxAcChargeW === null
      ? 0
      : falling(cfg.chargeExhaustLowW, cfg.chargeExhaustHighW, di.maxAcChargeW);
  const sunStrong = smootherstep(cfg.apsStrongLowW, cfg.apsStrongHighW, di.pvApsW);
  const freeCurtail = nearFull * chargeExhausted * sunStrong;

  const freeSurplus = Math.max(freeExport, freeCharge, freeCurtail);

  // Fenêtre solaire douce : ~0 la nuit (élévation < 12°). NB : ne suffit PAS à
  // éteindre l'hiver (élévation midi ~22° → window ~0,9) — c'est l'ABSENCE de
  // surplus (freeSurplus≈0) qui éteint l'hiver, pas la fenêtre. La fenêtre ne fait
  // qu'interdire la nuit.
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
 *  - freeSurplus porte la magnitude (surplus gratuit confirmé : export franc, charge
 *    au-dessus du heater, ou écrêtage prouvé batterie pleine).
 * VETO compteur muet : sans mesure EM-50 fiable, on ne peut pas garantir le
 * zéro-import → D=0 (comme le pilote booléen refuse d'allumer). VETO import : dès
 * qu'on soutire (> importVetoW), D=0 — le ballon ne cause JAMAIS d'achat EDF. VETO
 * cuisine : gros appareil → D=0 (la maison d'abord). Aucune voie confort ni prêt :
 * la sûreté est STRUCTURELLE (on ne chauffe qu'à batterie pleine sur du PV écrêté,
 * ou sur un export/charge qui dépasse le heater), pas laissée à une prévision.
 */
export function computeDesirability(di: DesInputs, cfg: DesConfig): DesResult {
  const s = computeSignals(di, cfg);
  let D = s.solarWindow * s.tankRoom * s.freeSurplus;

  const buyW = Math.max(0, di.gridPowerW);
  if (!di.em50Available) D = 0; // compteur muet : import inconnu → refus
  if (buyW > cfg.importVetoW) D = 0; // veto import : jamais chauffer en soutirant
  if (di.applianceActive) D = 0; // veto cuisine : la maison d'abord

  const reason = !di.em50Available
    ? 'compteur EM-50 muet — refus (import non vérifiable)'
    : di.applianceActive
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
                ? `écrêtage prouvé (batterie pleine, n’absorbe plus, soleil ${Math.round(di.pvApsW)} W)`
                : s.freeCharge > 0.4
                  ? `charge batterie > chauffe (SoC ${Math.round(di.socFrac * 100)} %)`
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
