/**
 * Estimateur d'énergie du ballon (ÉTAPE 1b — OBSERVATION PURE).
 *
 * `updateEnergyModel(inputs, config, state)` est une fonction PURE : aucune I/O,
 * AUCUN appel relais, AUCUNE influence sur `decide()`. Elle CALCULE une estimation
 * de l'énergie chaude disponible `E_avail` (Wh) et la retourne avec ses composantes
 * pour journalisation + historisation. Le moteur écrit le résultat dans l'état ;
 * il ne s'en sert PAS pour piloter.
 *
 * Principe :
 *   - bilan continu  : E_avail += E_injected − E_loss − E_drawn  (borné [0, E_full])
 *   - RECALAGE (vérité primaire) : dès que le ballon est connu plein (le cumulus a
 *     coupé, ou sonde chaude au repos) → E_avail = E_full. Le modèle de puisage ne
 *     sert qu'à limiter la dérive ENTRE deux recalages.
 *   - sonde LENTE (~20-30 min) → détection de puisage volontairement GROSSIÈRE
 *     (chute sonde au-delà des pertes attendues sur l'intervalle).
 *
 * `T_inlet`, `roomOffset` et `eDouche` sont interpolés hiver↔été selon la temp ext.
 */

import type { CumulusInputs, CumulusConfig, CumulusRuntimeState, EnergyState } from './types';

const MS_PER_H = 3_600_000;
const MAX_DT_MS = 300_000; // borne le Δt (ticks sautés / Domo redémarré) → pas d'inj/loss aberrant
const MAX_DRAW_INTERVAL_H = 2; // borne l'intervalle de pertes attendues (sonde figée longtemps → ne pas masquer un puisage)

const clamp = (lo: number, hi: number, x: number): number => Math.max(lo, Math.min(hi, x));

/** Interpolation linéaire hiver→été bornée selon la température extérieure. */
function lerpSeason(
  outdoorC: number,
  winterVal: number,
  summerVal: number,
  outdoorWinterC: number,
  outdoorSummerC: number
): number {
  const span = outdoorSummerC - outdoorWinterC;
  const f = span === 0 ? 0.5 : clamp(0, 1, (outdoorC - outdoorWinterC) / span);
  return winterVal + f * (summerVal - winterVal);
}

/** Détail d'un tick du modèle — pour le log et l'historisation. */
export interface EnergyTickResult {
  eAvailWh: number;
  eFullWh: number;
  tTankC: number;
  tInletC: number;
  tRoomC: number;
  outdoorC: number | null;
  indoorC: number | null;
  injWh: number; // ce tick
  lossWh: number; // ce tick
  drawWh: number; // ce tick
  injWhDay: number;
  lossWhDay: number;
  drawWhDay: number;
  drawEvent: { ts: number; dropC: number; eDrawnWh: number } | null;
  anchored: boolean;
  hoursSinceAnchor: number | null;
  showers: number; // E_avail / eDouche
  probeC: number | null;
}

/**
 * Met à jour l'estimation d'énergie du ballon. `state` est l'état runtime
 * APRÈS `decide()` (pour lire `ballonCharged` du tick courant). Retourne un
 * NOUVEL `EnergyState` à persister + le détail du tick. Ne mute pas ses arguments.
 */
export function updateEnergyModel(
  inputs: CumulusInputs,
  config: CumulusConfig,
  state: CumulusRuntimeState
): { energy: EnergyState; result: EnergyTickResult } {
  const em = config.energyModel;
  const now = inputs.now;
  const energy: EnergyState = { ...state.energy };

  const probeC = inputs.tempC; // sonde eau (point bas), offset déjà appliqué ; null si périmée
  const relayOn = inputs.relayOn === true;

  // ── Paramètres saisonniers (interpolés par la temp extérieure) ──
  const outdoorC = inputs.outdoorC ?? em.outdoorFallbackC;
  const tInlet = lerpSeason(
    outdoorC,
    em.inletWinterC,
    em.inletSummerC,
    em.outdoorWinterC,
    em.outdoorSummerC
  );
  const roomOffset = lerpSeason(
    outdoorC,
    em.roomOffsetWinterC,
    em.roomOffsetSummerC,
    em.outdoorWinterC,
    em.outdoorSummerC
  );
  const eDouche = lerpSeason(
    outdoorC,
    em.eDoucheWhWinter,
    em.eDoucheWhSummer,
    em.outdoorWinterC,
    em.outdoorSummerC
  );
  const tRoom = inputs.indoorC !== null ? inputs.indoorC - roomOffset : em.roomFallbackC;

  const eFull = Math.max(0, em.tankWhPerC * (em.setpointC - tInlet));

  // ── Bascule de jour : reset des composantes cumulées ──
  if (inputs.todayParis !== energy.dayDate) {
    energy.dayDate = inputs.todayParis;
    energy.injWhDay = 0;
    energy.lossWhDay = 0;
    energy.drawWhDay = 0;
    energy.drawEvents = 0;
  }

  // ── Initialisation : estimation BASSE depuis la sonde, dès qu'elle est dispo ──
  // Si le 1er tick suit un redémarrage AVANT l'arrivée du retained MQTT, on pose un
  // provisoire « demi-plein » puis on RÉ-INITIALISE au premier vrai relevé de sonde
  // (tant qu'aucune sonde n'a encore été vue : lastProbeC === null).
  let eAvail = energy.eAvailWh;
  const firstTick = energy.lastUpdateTs === null;
  const initFromProbe = probeC !== null && (firstTick || energy.lastProbeC === null);
  if (initFromProbe) {
    eAvail = clamp(0, eFull, em.tankWhPerC * Math.max(0, (probeC as number) - tInlet));
  } else if (firstTick) {
    eAvail = clamp(0, eFull, 0.5 * eFull); // sonde encore absente → demi-plein prudent
  }

  // ── Δt borné (immunise contre les ticks sautés / redémarrages) ──
  const dtMs = firstTick ? 0 : clamp(0, MAX_DT_MS, now - (energy.lastUpdateTs as number));
  const dtH = dtMs / MS_PER_H;

  // T_tank déduite de l'énergie courante (avant mise à jour).
  let tTank = tInlet + eAvail / em.tankWhPerC;

  // ── Injection (EM-50 voie cumulus) & pertes thermiques ──
  const cumulusW = inputs.em50Available ? Math.max(0, inputs.cumulusPowerW) : 0;
  const injWh = em.etaHeat * cumulusW * dtH;
  const lossWh = em.lossCoeffWhPerCh * Math.max(0, tTank - tRoom) * dtH;

  // ── Détection de puisage (événementielle, sur changement de sonde) ──
  // La sonde est lente : on ne compare que quand sa valeur CHANGE, et on confronte
  // la chute observée aux pertes attendues sur l'intervalle depuis le dernier point.
  let drawWh = 0;
  let drawEvent: EnergyTickResult['drawEvent'] = null;
  const probeChanged =
    probeC !== null && energy.lastProbeC !== null && probeC !== energy.lastProbeC;
  if (probeChanged && !relayOn) {
    const intervalH =
      energy.lastProbeTs !== null
        ? Math.min(MAX_DRAW_INTERVAL_H, Math.max(0, (now - energy.lastProbeTs) / MS_PER_H))
        : 0;
    const expectedLossDropC =
      (em.lossCoeffWhPerCh * Math.max(0, tTank - tRoom) * intervalH) / em.tankWhPerC;
    const dropC = (energy.lastProbeC as number) - (probeC as number); // + = refroidissement
    if (dropC > expectedLossDropC + em.drawDropThresholdC) {
      drawWh = eDouche;
      drawEvent = { ts: now, dropC: +dropC.toFixed(2), eDrawnWh: Math.round(eDouche) };
      energy.drawEvents += 1;
    }
  }

  // ── Recalage = VÉRITÉ PRIMAIRE ──
  // Ballon connu plein : (a) le cumulus a coupé (ballonCharged posé par decide), ou
  // (b) sonde chaude au repos (relais off, T ≥ seuil) → E_avail = E_full.
  const restHot = probeC !== null && !relayOn && probeC >= em.probeFullRestC;
  const anchored = state.ballonCharged === true || restHot;
  if (anchored) {
    eAvail = eFull;
    energy.lastAnchorTs = now;
    drawWh = 0; // pas de puisage quand on recale au plein
    drawEvent = null;
  } else if (!firstTick && !initFromProbe) {
    eAvail = clamp(0, eFull, eAvail + injWh - lossWh - drawWh);
  }

  // ── Composantes cumulées du jour (flux réels mesurés) ──
  // Seulement quand le bilan continu s'applique : sur un tick d'init/ré-init,
  // injWh/lossWh sont calculés sur un E_avail provisoire (sonde pas encore stable)
  // puis le bilan est jeté → on ne les comptabilise pas. Sur un tick normal (y
  // compris anchor), ce sont de vrais flux → on les cumule.
  if (!firstTick && !initFromProbe) {
    energy.injWhDay = +(energy.injWhDay + injWh).toFixed(1);
    energy.lossWhDay = +(energy.lossWhDay + lossWh).toFixed(1);
    energy.drawWhDay = +(energy.drawWhDay + drawWh).toFixed(1);
  }

  // ── Suivi de la sonde (mémorise la dernière valeur DISTINCTE) ──
  if (probeC !== null && (energy.lastProbeC === null || probeChanged)) {
    energy.lastProbeC = probeC;
    energy.lastProbeTs = now;
  }

  energy.eAvailWh = Math.round(eAvail);
  energy.lastUpdateTs = now;

  tTank = tInlet + eAvail / em.tankWhPerC;
  const showers = eDouche > 0 ? eAvail / eDouche : 0;
  const hoursSinceAnchor =
    energy.lastAnchorTs !== null ? (now - energy.lastAnchorTs) / MS_PER_H : null;

  return {
    energy,
    result: {
      eAvailWh: energy.eAvailWh,
      eFullWh: Math.round(eFull),
      tTankC: +tTank.toFixed(1),
      tInletC: +tInlet.toFixed(1),
      tRoomC: +tRoom.toFixed(1),
      outdoorC: inputs.outdoorC,
      indoorC: inputs.indoorC,
      injWh: +injWh.toFixed(1),
      lossWh: +lossWh.toFixed(1),
      drawWh: +drawWh.toFixed(1),
      injWhDay: energy.injWhDay,
      lossWhDay: energy.lossWhDay,
      drawWhDay: energy.drawWhDay,
      drawEvent,
      anchored,
      hoursSinceAnchor,
      showers,
      probeC
    }
  };
}
