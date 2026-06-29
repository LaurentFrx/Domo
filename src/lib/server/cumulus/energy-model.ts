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

/** Moyenne (arrondie 0,1 °C) des sources de température disponibles, ou null si aucune. */
export function averageTemp(sources: { tempC: number }[]): number | null {
  if (!sources.length) return null;
  return +(sources.reduce((s, x) => s + x.tempC, 0) / sources.length).toFixed(1);
}

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

  // ── Détection de puisage par FENÊTRE GLISSANTE (sonde lente) ──────────────
  // On compare la sonde à une référence « point haut récent » (au moins
  // drawWindowMin), au-delà de ce que les pertes expliquent → ÉVÉNEMENT. Fini la
  // comparaison tick-à-tick (qui étalait la chute sous le seuil) ; plus de garde
  // relais ni de masquage par l'anchor : un vrai tirage est toujours vu + historisé.
  let drawWh = 0;
  let drawEvent: EnergyTickResult['drawEvent'] = null;
  if (probeC !== null) {
    if (energy.drawRefC === null || firstTick || initFromProbe) {
      energy.drawRefC = probeC;
      energy.drawRefTs = now;
    } else if (probeC >= energy.drawRefC) {
      // la sonde remonte (chauffe / re-stratification) → nouveau point haut
      energy.drawRefC = probeC;
      energy.drawRefTs = now;
    } else {
      const intervalH = Math.max(0, (now - (energy.drawRefTs as number)) / MS_PER_H);
      const capInt = Math.min(MAX_DRAW_INTERVAL_H, intervalH);
      const expLossC = (em.lossCoeffWhPerCh * Math.max(0, tTank - tRoom) * capInt) / em.tankWhPerC;
      const dropC = energy.drawRefC - probeC;
      if (intervalH * 60 >= em.drawWindowMin && dropC > expLossC + em.drawDropThresholdC) {
        // chute nette au-delà des pertes, sur la fenêtre → PUISAGE. La sonde de point
        // bas SUR-REPRÉSENTE l'amplitude (~×drawStratFactor) : l'eau froide entre par
        // le bas → la sonde chute plus vite que la température MOYENNE du ballon.
        // Facteur calibré par calorimétrie EM-50 (replay 14→29/06 : puisé corrigé ≈
        // E_recharge − pertes). On divise l'énergie « vue » par drawStratFactor pour
        // approcher l'énergie réellement puisée (estimateur, pas débitmètre ; clamp ≥ 0
        // en aval ; l'erreur résiduelle est bornée par les recalages au plein).
        drawWh = (Math.max(0, dropC - expLossC) * em.tankWhPerC) / em.drawStratFactor;
        drawEvent = { ts: now, dropC: +dropC.toFixed(2), eDrawnWh: Math.round(drawWh) };
        energy.drawEvents += 1;
        energy.drawRefC = probeC; // consommé : nouvelle référence au point bas
        energy.drawRefTs = now;
      } else if (intervalH >= MAX_DRAW_INTERVAL_H) {
        // longue période sans tirage → glissement de la référence (anti-dérive lente)
        energy.drawRefC = probeC;
        energy.drawRefTs = now;
      }
    }
  }

  // ── Recalage = VÉRITÉ PRIMAIRE (sur la VALEUR ABSOLUE de la sonde) ──────────
  // Ballon connu plein : cumulus a coupé (ballonCharged) OU sonde ≥ seuil au repos.
  // L'anchor n'EFFACE PLUS l'événement de puisage (il reste journalisé) ; il ne fait
  // que recaler E_avail = E_full quand le ballon est réellement chaud.
  const restHot = probeC !== null && !relayOn && probeC >= em.probeFullRestC;
  const anchored = state.ballonCharged === true || restHot;
  if (anchored) {
    eAvail = eFull;
    if (!energy.wasFull) energy.lastAnchorTs = now;
    energy.wasFull = true;
  } else {
    energy.wasFull = false;
    if (!firstTick && !initFromProbe) {
      eAvail = clamp(0, eFull, eAvail + injWh - lossWh - drawWh);
    }
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

  // ── Suivi de la sonde (dernière valeur DISTINCTE) — journalisée comme probe_c ──
  if (probeC !== null && probeC !== energy.lastProbeC) {
    energy.lastProbeC = probeC;
    energy.lastProbeTs = now;
  }

  energy.eAvailWh = Math.round(eAvail);
  energy.lastUpdateTs = now;
  energy.tRoomC = inputs.indoorC; // moyennes du tick → historisées (calibration lossCoeff)
  energy.tExtC = inputs.outdoorC;

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
