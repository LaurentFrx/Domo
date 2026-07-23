/**
 * Modèle CONTINU de désirabilité de chauffe du cumulus — « les potentiomètres ».
 *
 * Remplace la logique booléenne à seuils (les 3 branches du trigger + le verrou
 * Max AC ≥ 65 %) par un modèle d'utilité continu : chaque entrée devient un
 * signal analogique ∈ [0,1] via une courbe de réponse non-linéaire (smootherstep
 * = S-curve de Perlin, dérivées 1re ET 2de nulles aux bords — l'équivalent d'une
 * courbe de Bézier douce), certains signaux intégrant une DÉRIVÉE (vitesse de
 * charge batterie → anticipation de l'écrêtage ; refroidissement + échéance
 * douches → anticipation du confort). Ces signaux s'assemblent en une seule
 * grandeur D ∈ [0,1] — la « désirabilité de chauffe » — qui franchit UN seuil à
 * hystérésis pour donner la sortie on/off. Aucun signal ne domine : ce sont des
 * pierres qui se contraignent (§assemblage).
 *
 * PÉRIMÈTRE : ce module gouverne la décision SOLAIRE de journée. La recharge HC
 * nocturne (plan) et les coupures dures (zéro-import, cuisine, anti-cycle) restent
 * gérées par pilot.ts — elles bornent D en aval. « La sophistication bornée par
 * les données » : riche l'été (mesuré), l'hiver retombe sur solarWindowSoft ≈ 0
 * → D ≈ 0 → le repli HC prend la main (pas de modèle spéculatif là où on est
 * aveugle).
 */

// ─── Primitives de mise en forme (courbes continues) ────────────────────────

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * S-curve de Perlin : 0 en e0, 1 en e1, plate (dérivées 1re ET 2de nulles) aux
 * deux bords. C'est le remplaçant continu et SANS FALAISE d'un seuil booléen —
 * une bascule 64/66 % ne produit plus qu'un écart infinitésimal de score.
 */
export function smootherstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Rampe DÉCROISSANTE : 1 en e0, 0 en e1 (miroir de smootherstep). */
const falling = (e0: number, e1: number, x: number): number => 1 - smootherstep(e0, e1, x);

// ─── Contrat d'entrée du modèle (normalisable depuis CumulusInputs+PilotCtx
//     OU reconstruit depuis le recorder pour le backtest) ────────────────────

export interface DesInputs {
  /** Élévation solaire (°) — éphémérides. */
  sunElevDeg: number;
  /** Énergie thermique stockée dans la cuve (Wh, sur °C-MOYENNE, jamais la sonde). */
  eAvailWh: number;
  /** Énergie cuve pleine (Wh). */
  eFullWh: number;
  /** Réserve de confort « douces garanties » (Wh) — plancher souple. */
  comfortReserveWh: number;
  /** Minimum de confort DUR (Wh) — sous lui, chauffe quasi impérative. */
  hardComfortWh: number;
  /** Pertes actuelles de la cuve (Wh/h) — pour projeter le refroidissement. */
  lossPerHWh: number;
  /** Minutes avant la prochaine échéance de puisage (douches du matin), ou grand si loin. */
  minutesToDeadline: number;
  /** Réseau signé (W) : + soutirage EDF / − injection. */
  gridPowerW: number;
  /** Charge AC absorbée par la Max AC (W ≥ 0) = surplus qui vit dans la batterie ; null si muet. */
  maxAcChargeW: number | null;
  /** SoC du parc batterie, fraction 0..1. */
  socFrac: number;
  /** DÉRIVÉE du SoC parc (fraction par heure) — signe + = en charge. */
  dSocFracPerH: number;
  /** Énergie PV encore attendue aujourd'hui (kWh) — prévision × reste de journée. */
  forecastRemainingKwh: number;
  /** Cible de réserve batterie pour le soir/nuit (kWh) — première créance de la maison. */
  eveningReserveKwh: number;
  /** Capacité batterie totale (kWh) — pour convertir SoC↔kWh. */
  batteryCapacityKwh: number;
  /** Puissance de chauffe (W) — échelle de saturation des signaux de surplus. */
  heaterW: number;
  /** Un gros appareil (four/plaques/lave-*) tourne → veto cuisine. */
  applianceActive: boolean;
}

export interface DesConfig {
  /** Seuil d'export (W) où le signal free commence à monter (bas — capte 200 W). */
  exportKneeW: number;
  /** Fraction SoC où l'écrêtage devient probable (batterie proche du plein). */
  curtailSocLow: number;
  curtailSocHigh: number;
  /** Fraction SoC où la charge batterie devient du VRAI surplus (au-dessus de sa réserve). */
  surplusSocLow: number;
  surplusSocHigh: number;
  /** Anticipation : dérivée SoC (frac/h) au-delà de laquelle la saturation est « imminente ». */
  chargeRateAnticipH: number;
  /** Fenêtre solaire douce : élévation de début/fin de rampe (°). */
  sunSoftLowDeg: number;
  sunSoftHighDeg: number;
  /** Plan journalier : PV restant (kWh) où la confiance solaire monte de 0 à 1. */
  planLowKwh: number;
  planHighKwh: number;
  /** Hystérésis de sortie sur D. */
  dOn: number;
  dOff: number;
}

export function defaultDesConfig(): DesConfig {
  return {
    exportKneeW: 150,
    curtailSocLow: 0.82,
    curtailSocHigh: 0.98,
    surplusSocLow: 0.75, // sous 75 % la charge remplit la réserve nécessaire, pas du surplus
    surplusSocHigh: 0.9, // au-dessus de 90 % la charge est du surplus partageable
    chargeRateAnticipH: 0.12, // +12 pts/h ≈ charge franche → saturation à venir
    sunSoftLowDeg: 12,
    sunSoftHighDeg: 25,
    planLowKwh: 2, // sous 2 kWh de soleil restant → aucun prêt (repli HC)
    planHighKwh: 6, // au-delà de 6 kWh restant → journée solaire franche
    dOn: 0.55,
    dOff: 0.35
  };
}

// ─── Signaux (chacun ∈ [0,1]) ───────────────────────────────────────────────

export interface DesSignals {
  tankRoom: number; // PORTAIL de place : ~1 tant que la cuve n'est pas quasi pleine, 0 près du plein
  comfortUrgency: number; // urgence confort (échéance douches + refroidissement projeté)
  freeSurplus: number; // surplus RÉELLEMENT gratuit dispo maintenant (export + écrêtage + charge Max AC)
  reserveHealth: number; // batterie DÉJÀ au-dessus de sa réserve du soir (1 = prêter OK)
  solarConfidence: number; // plan journalier : le soleil restant refera-t-il la batterie ? (1 = journée solaire)
  solarWindow: number; // fenêtre solaire douce (0 la nuit/hiver)
}

export function computeSignals(di: DesInputs, cfg: DesConfig): DesSignals {
  // tankRoom : PORTAIL de place — ~1 tant que la cuve a de la place, ne se ferme
  // que dans les 7 % du haut (valeur marginale décroissante uniquement tout près
  // du plein). C'est un portail (permis/pas permis), pas une magnitude — sinon
  // le produit final n'atteint jamais le seuil (bug d'assemblage du 1er jet).
  const tankRoom = falling(0.93 * di.eFullWh, 0.99 * di.eFullWh, di.eAvailWh);

  // comfortUrgency : l'échéance des douches croisée au refroidissement PROJETÉ.
  // On projette l'énergie cuve à l'échéance (eAvail − pertes×heures) ; si elle
  // passe sous le confort dur, l'urgence monte. Anticipation = dérivée (pertes)
  // × temps. Sature à 1 si déjà sous le confort dur MAINTENANT.
  // Urgence = 1 sous le confort DUR (hardComfortWh), retombe à 0 en atteignant la
  // réserve confort (comfortReserveWh). Args dans l'ordre croissant (bord bas →
  // bord haut) — l'inverse donnait urgence=1 même cuve pleine.
  const hoursToDeadline = Math.max(0, di.minutesToDeadline) / 60;
  const projectedWh = di.eAvailWh - di.lossPerHWh * hoursToDeadline;
  const urgencyDeadline = falling(di.hardComfortWh, di.comfortReserveWh, projectedWh);
  const urgencyNow = falling(di.hardComfortWh, di.comfortReserveWh, di.eAvailWh);
  const comfortUrgency = Math.max(urgencyDeadline, urgencyNow);

  // freeSurplus : trois indicateurs de surplus GRATUIT, on prend le max (n'importe
  // lequel suffit). (a) export franc au compteur ; (b) charge de la Max AC (le
  // surplus « vit » là depuis le zéro-export) ; (c) ÉCRÊTAGE anticipé — batterie
  // proche du plein ET qui charge encore franchement (dérivée positive) → les
  // panneaux vont être bridés, le ballon doit préempter ce PV sinon perdu.
  // (a) export franc au compteur = énergie VRAIMENT perdue (0 €, pas de revente) → compte toujours.
  const exportW = Math.max(0, -di.gridPowerW);
  const freeExport = smootherstep(cfg.exportKneeW, di.heaterW, exportW);
  // (b) charge batterie comme surplus pour le ballon — MAIS seulement quand la
  // batterie est DÉJÀ au-dessus de sa réserve : une batterie basse qui charge
  // remplit son PROPRE besoin (réserve du soir), ce n'est pas du surplus à voler
  // (leçon 23/07 : à 51 % chargeant 4,7 kW, elle se refait, le ballon ne doit pas
  // concourir). Au-delà de ~80 %, sa charge devient du vrai surplus partageable.
  const battIsSurplus = smootherstep(cfg.surplusSocLow, cfg.surplusSocHigh, di.socFrac);
  const chargeMag =
    di.maxAcChargeW === null ? 0 : smootherstep(cfg.exportKneeW, 1500, di.maxAcChargeW);
  const freeCharge = chargeMag * battIsSurplus;
  // (c) écrêtage anticipé : batterie proche du plein ET encore en charge franche
  // (dérivée +) → les panneaux vont brider, préempter ce PV sinon perdu.
  const curtailProximity = smootherstep(cfg.curtailSocLow, cfg.curtailSocHigh, di.socFrac);
  const chargeStillFranc = smootherstep(0, cfg.chargeRateAnticipH, di.dSocFracPerH);
  const freeCurtail = curtailProximity * chargeStillFranc;
  const freeSurplus = Math.max(freeExport, freeCharge, freeCurtail);

  // reserveHealth : la batterie est-elle DÉJÀ au-dessus de sa réserve du soir
  // (première créance de la maison) ? SoC courant vs cible + marge. C'est la
  // condition pour PRÊTER du courant au ballon sans surplus instantané — bornée
  // par la créance de la batterie (basse → ne prête pas).
  const socKwh = di.socFrac * di.batteryCapacityKwh;
  const reserveHealth = smootherstep(
    di.eveningReserveKwh,
    di.eveningReserveKwh + 2, // +2 kWh au-dessus de la réserve = pleinement sain
    socKwh
  );

  // solarConfidence : le PLAN JOURNALIER. Le soleil RESTANT prévu (AROME) suffit-il
  // à refaire la batterie après un prêt au ballon ? Élevé → journée solaire, on
  // peut chauffer au plein ; bas → journée pauvre, on ne prête pas (repli HC).
  // C'est l'arbitrage par prévision, en continu (étude : PV ≥14 solaire / <11 HC).
  const solarConfidence = smootherstep(cfg.planLowKwh, cfg.planHighKwh, di.forecastRemainingKwh);

  // solarWindow : rampe douce sur l'élévation. ~0 la nuit et l'hiver (le soleil
  // ne franchit jamais sunSoftHigh en déc → D≈0 → repli HC, pas de spéculation).
  const solarWindow = smootherstep(cfg.sunSoftLowDeg, cfg.sunSoftHighDeg, di.sunElevDeg);

  return { tankRoom, comfortUrgency, freeSurplus, reserveHealth, solarConfidence, solarWindow };
}

// ─── Assemblage : D ∈ [0,1] ─────────────────────────────────────────────────

export interface DesResult {
  D: number;
  signals: DesSignals;
  /** Opportunité économique (surplus gratuit OU réserve saine sous le soleil). */
  opportunity: number;
  reason: string;
}

/**
 * D = fenêtre × place-à-chauffer × opportunité, avec un plancher d'URGENCE
 * confort. Aucun facteur ne domine : la fenêtre annule l'hiver/nuit ; la place
 * annule le ballon plein ; l'opportunité exige soit du surplus gratuit, soit une
 * réserve saine sous le soleil (jamais voler la réserve d'un jour pauvre).
 * L'urgence confort (échéance douches) peut relever D même sans surplus franc —
 * mais reste sous fenêtre (elle ne force pas un import de nuit ; c'est le rôle du
 * plan HC). Le veto cuisine écrase tout : la maison d'abord.
 */
export function computeDesirability(di: DesInputs, cfg: DesConfig): DesResult {
  const s = computeSignals(di, cfg);

  // Opportunité = surplus RÉELLEMENT gratuit MAINTENANT (export perdu, charge
  // au-dessus de la réserve, écrêtage) OU « voie de prêt » : chauffer en tirant
  // un peu de la batterie, autorisé SEULEMENT si les trois pierres s'alignent —
  // batterie déjà au-dessus de sa réserve (reserveHealth) ET journée solaire qui
  // la refera (solarConfidence) ET soleil présent (solarWindow). C'est le
  // corollaire « ne pas brider tant que le ballon a de la place », borné par la
  // première créance de la batterie et arbitré par la prévision. Aucune pierre ne
  // domine : chacune peut fermer la voie de prêt ; le surplus franc, lui, passe
  // toujours (on ne gaspille jamais du 0 €).
  const lendPath = s.reserveHealth * s.solarConfidence * s.solarWindow;
  const opportunity = Math.max(s.freeSurplus, lendPath);

  // Base : on chauffe s'il y a de la place ET une opportunité, dans la fenêtre.
  let D = s.solarWindow * s.tankRoom * opportunity;

  // Plancher d'urgence : un ballon qui file vers le froid avant les douches tire
  // D vers le haut même sur opportunité modeste (mais toujours × fenêtre : de
  // jour ; la nuit c'est le plan HC). Combiné en OR-doux (probabiliste).
  const urgencyDrive = s.solarWindow * s.tankRoom * s.comfortUrgency;
  D = 1 - (1 - D) * (1 - urgencyDrive);

  // Veto cuisine : gros appareil en marche → la maison d'abord.
  if (di.applianceActive) D = 0;

  const reason = di.applianceActive
    ? 'veto cuisine (gros appareil en marche)'
    : s.solarWindow < 0.05
      ? 'hors fenêtre solaire (nuit/hiver) — repli HC'
      : s.tankRoom < 0.05
        ? 'ballon plein'
        : opportunity < 0.1 && s.comfortUrgency < 0.1
          ? 'ni surplus gratuit ni réserve saine ni urgence — on attend'
          : s.freeSurplus > 0.4
            ? `surplus gratuit (${Math.round(s.freeSurplus * 100)}%) → chauffe`
            : s.comfortUrgency > 0.4
              ? `urgence confort (${Math.round(s.comfortUrgency * 100)}%)`
              : `réserve saine sous le soleil (${Math.round(s.reserveHealth * 100)}%)`;

  return { D: clamp01(D), signals: s, opportunity, reason };
}

/**
 * Sortie on/off à HYSTÉRÉSIS — la conversion continu→binaire, tout à la fin.
 * ON quand D franchit dOn ; reste ON tant que D > dOff ; la bande dOn−dOff évite
 * le battement. (Les min-on/off/anti-cycle restent gérés par pilot.ts en aval.)
 */
export function hysteresisOn(D: number, prevOn: boolean, cfg: DesConfig): boolean {
  return prevOn ? D > cfg.dOff : D > cfg.dOn;
}
