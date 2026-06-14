/**
 * Moteur de décision PUR de l'orchestrateur cumulus.
 *
 * `decide(inputs, config, state)` ne fait AUCUNE I/O : il prend un instantané
 * d'entrées (déjà collectées), la config et l'état runtime, et retourne la
 * décision + le nouvel état (pattern reducer). Tout effet (POST relais,
 * persistance, journal) est réalisé par `tick()` dans engine.ts.
 *
 * Profil « Solaire d'abord » — arbre de priorités décroissantes :
 *   override (manuel/vacances) > panne > sécurité haute > ballon plein >
 *   confort mini garanti > anti-légionellose > surplus PV > heures creuses
 *   (modulé météo) > veille.  Le tout sous anti-court-cycle (sauf sécurité/confort).
 *
 * Grandeur clé : le **surplus reconstitué** = cumulusPowerW − gridPowerW, qui
 * neutralise la conso de la résistance dans la mesure réseau (sans quoi le
 * surplus « disparaît » dès qu'on chauffe et la régulation oscille).
 */

import type { CumulusMode } from '$theme/tokens';
import type {
  CumulusInputs,
  CumulusConfig,
  CumulusRuntimeState,
  Decision,
  DecisionReason,
  Anomaly
} from './types';

const SEC = 1000;

/** Branches de chauffe AUTOMATIQUE débrayées en mode observation (manuel/boost exclus). */
const OBSERVE_NEUTRALISES = new Set<DecisionReason>(['comfort_min', 'solar', 'offpeak_boost']);

/** Sous-mode (couleur UI) déduit de la raison + de l'état du relais. */
function subModeFor(reason: DecisionReason, on: boolean): CumulusMode {
  switch (reason) {
    case 'solar':
      return 'PV';
    case 'offpeak':
    case 'offpeak_boost':
      return 'HC';
    case 'comfort_min':
    case 'legionella':
    case 'manual_on':
    case 'boost':
      return 'FORCE';
    case 'safety_high':
    case 'tank_full':
    case 'vacation_off':
    case 'manual_off':
    case 'observe_only':
    case 'idle':
      return 'OFF';
    default: // cold_start, anticycle_hold
      return on ? 'FORCE' : 'OFF';
  }
}

export function decide(
  inputs: CumulusInputs,
  config: CumulusConfig,
  state: CumulusRuntimeState
): Decision {
  const { now } = inputs;
  const next: CumulusRuntimeState = { ...state };

  const T = inputs.tempC; // °C, déjà corrigé de l'offset ; null = inconnue/périmée
  const tKnown = T !== null;
  next.lastTempC = T; // exposé à l'UI (réserve d'eau chaude), jamais affiché en degrés bruts

  // Désinfection : tracée dès que l'eau (point bas, sonde doigt de gant) atteint ≥60°C —
  // ce qu'une chauffe complète garantit (le cumulus coupe à sa consigne >60°C). Pas de cycle.
  if (tKnown && (T as number) >= 60) next.lastDisinfectTs = now;

  // Surplus PV reconstitué (W) — ce qui resterait si le cumulus s'arrêtait.
  const surplusW = inputs.em50Available ? Math.round(inputs.cumulusPowerW - inputs.gridPowerW) : 0;

  // ── Suivi « relais physiquement ON depuis » (base des détections conso) ──
  if (inputs.relayOn === true) {
    if (next.onSinceTs === null) next.onSinceTs = now;
  } else {
    next.onSinceTs = null;
  }

  // ── Énergie injectée du jour (delta du compteur cumulatif EM-50) ──
  if (inputs.todayParis !== next.energyDayDate) {
    next.energyDayDate = inputs.todayParis;
    next.energyTodayKwh = 0;
    next.lastCumulusKwh = inputs.em50Available ? inputs.cumulusKwh : null;
  }
  if (inputs.em50Available && Number.isFinite(inputs.cumulusKwh)) {
    if (next.lastCumulusKwh !== null) {
      const d = inputs.cumulusKwh - next.lastCumulusKwh;
      if (d > 0 && d < 5) next.energyTodayKwh = +(next.energyTodayKwh + d).toFixed(3); // borne anti-saut
    }
    next.lastCumulusKwh = inputs.cumulusKwh;
  }

  // ── Invalidation « ballon plein » après refroidissement (puisage) ──
  if (next.ballonCharged && tKnown && next.chargedAtTempC !== null) {
    if ((T as number) <= next.chargedAtTempC - config.rechargeHysteresisC) {
      next.ballonCharged = false;
      next.chargedAtTempC = null;
    }
  }
  // Un « Chauffer maintenant » demandé alors que le ballon est déjà plein est sans objet.
  if (next.boostUntilFull && next.ballonCharged) next.boostUntilFull = false;

  // ── Repli : relais injoignable → on ne pilote rien (cold start / panne tunnel) ──
  if (!inputs.relayAvailable) {
    next.lastReason = 'cold_start';
    next.anomaly = 'relay_unreachable';
    return {
      relayDesired: state.relayDesired ?? false,
      reason: 'cold_start',
      subMode: state.lastSubMode,
      anomaly: 'relay_unreachable',
      surplusW,
      note: 'relais injoignable — aucun ordre',
      apply: false,
      nextState: next
    };
  }

  const relayOn = inputs.relayOn; // boolean (relais joignable)
  let anomaly: Anomaly = tKnown ? 'none' : 'sensor_stale';

  // ── Hystérésis surplus : grâce anti-nuage avant de couper la chauffe solaire ──
  const aboveOff = inputs.em50Available && surplusW >= config.surplusOffW;
  if (relayOn === true && inputs.em50Available && !aboveOff) {
    if (next.surplusBelowSinceTs === null) next.surplusBelowSinceTs = now;
  } else {
    next.surplusBelowSinceTs = null;
  }
  const graceActive =
    next.surplusBelowSinceTs !== null &&
    now - next.surplusBelowSinceTs < config.surplusOffGraceSec * SEC;

  // ── Détection fin de chauffe (ballon plein) vs panne résistance ──
  const lowPower = inputs.em50Available && inputs.cumulusPowerW < config.tankFullPowerW;
  if (relayOn === true && lowPower) {
    if (next.lowPowerSinceTs === null) next.lowPowerSinceTs = now;
  } else {
    next.lowPowerSinceTs = null;
  }
  const onMs = next.onSinceTs !== null ? now - next.onSinceTs : 0;
  const lowMs = next.lowPowerSinceTs !== null ? now - next.lowPowerSinceTs : 0;
  const stableLow =
    relayOn === true &&
    onMs >= config.tankFullConfirmSec * SEC &&
    lowMs >= config.tankFullConfirmSec * SEC;

  let tankFull = false;
  if (stableLow) {
    if (!tKnown || (T as number) >= config.tminConfortC) {
      tankFull = true; // conso nulle + eau au moins tiède (ou T inconnue) → thermostat mécanique a coupé
    } else if (onMs >= config.faultConfirmSec * SEC) {
      anomaly = 'heater_fault'; // conso nulle + eau froide depuis longtemps → résistance/disjoncteur
    }
    // eau froide + conso nulle depuis < faultConfirmSec : on patiente (ni plein ni panne)
  }

  // ── « Wants » des différentes branches (profil Solaire d'abord) ──
  // Confort : déclenche sous Tmin, puis MAINTIENT jusqu'à ce que le cumulus coupe
  // (comme les autres modes : c'est le cumulus qui décide la fin, pas une cible).
  const comfortHold = relayOn === true && state.lastReason === 'comfort_min' && !next.ballonCharged;
  const comfortWants =
    !next.ballonCharged && ((tKnown && (T as number) < config.tminConfortC) || comfortHold);

  // Prévision : « peu de soleil demain » (< seuil) autorise la chauffe nocturne en HC.
  // Sinon (beau temps prévu), AUCUNE chauffe nocturne au-delà du confort mini : le
  // solaire gratuit du lendemain s'en chargera.
  const poorSolarTomorrow =
    inputs.forecastAvailable && inputs.solNextDaylightKwh < config.forecastFaibleKwh;
  const bigSurplus = inputs.em50Available && surplusW >= config.surplusOnW;

  // Surplus PV : chauffe tant qu'il y a du soleil gratuit ET que le ballon n'est pas
  // plein. PAS de cible de température : c'est le thermostat du CUMULUS qui décide la fin
  // (il coupe l'alim de la résistance → la conso tombe → ballonCharged, détecté plus haut).
  const solarHold = relayOn === true && inputs.em50Available && (aboveOff || graceActive);
  const solarWants = !next.ballonCharged && (bigSurplus || solarHold);

  // Heures creuses : chauffe (jusqu'à la coupure du cumulus) si peu de soleil prévu demain
  // ET ballon pas déjà plein. Par beau temps → rien la nuit (seul le confort mini agit).
  const hcWants = !next.ballonCharged && inputs.isHC && poorSolarTomorrow;

  // ── Arbre de décision ──
  let desired: boolean;
  let reason: DecisionReason;
  let bypass = false; // contourne l'anti-court-cycle (sécurité / confort / override)
  let note = '';

  if (state.autoMode === 'off') {
    desired = false;
    reason = 'vacation_off';
    bypass = true;
    note = 'mode vacances';
  } else if (state.autoMode === 'manual') {
    // Manuel : l'utilisateur commande, mais la sécurité haute reste un garde-fou.
    if (state.manualRelayOn && tKnown && (T as number) >= config.tmaxSondeC) {
      desired = false;
      reason = 'safety_high';
      bypass = true;
      note = `sécurité ${Math.round(T as number)}°C`;
    } else {
      desired = state.manualRelayOn;
      reason = state.manualRelayOn ? 'manual_on' : 'manual_off';
      bypass = true;
      note = 'commande manuelle';
    }
  } else if (anomaly === 'heater_fault') {
    desired = false;
    reason = 'idle';
    bypass = true;
    note = 'anomalie : aucune chauffe détectée';
  } else if (tKnown && (T as number) >= config.tmaxSondeC) {
    desired = false;
    reason = 'safety_high';
    bypass = true;
    note = `sécurité ${Math.round(T as number)}°C ≥ ${config.tmaxSondeC}°C`;
  } else if (tankFull) {
    desired = false;
    reason = 'tank_full';
    note = 'ballon plein (le cumulus a coupé)';
    next.ballonCharged = true;
    next.chargedAtTempC = T; // température observée à la coupure du cumulus = sa consigne réelle
    next.boostUntilFull = false; // chauffe à la demande terminée
  } else if (next.boostUntilFull && !next.ballonCharged) {
    desired = true;
    reason = 'boost';
    note = 'chauffe lancée à la demande (jusqu’au plein)';
  } else if (comfortWants) {
    desired = true;
    reason = 'comfort_min';
    bypass = true;
    note = tKnown
      ? `confort : ${Math.round(T as number)}°C < ${config.tminConfortC}°C`
      : 'confort (sonde HS)';
  } else if (solarWants) {
    desired = true;
    reason = 'solar';
    note = `surplus PV ${surplusW} W`;
  } else if (hcWants) {
    desired = true;
    reason = 'offpeak_boost';
    note = 'heures creuses (peu de soleil prévu) — jusqu’à coupure du cumulus';
  } else {
    desired = false;
    reason = 'idle';
    note = inputs.isHC
      ? poorSolarTomorrow
        ? 'creuses : ballon suffisant'
        : 'creuses : beau temps prévu, pas de chauffe'
      : 'veille (ni surplus ni HC)';
  }

  // ── Mode observation (ÉTAPE 1a) : neutralise les chauffes AUTOMATIQUES ──
  // Le moteur ne commande PLUS le relais pour comfort_min / solar / offpeak_boost
  // (il journalise « aurait chauffé »). Restent intacts : manuel, boost « Chauffer
  // maintenant », tank_full, sécurité haute, et l'anti-court-cycle ci-dessous.
  if (config.observationMode && desired && OBSERVE_NEUTRALISES.has(reason)) {
    note = `observation : aurait chauffé (${reason}) — relais NON commandé`;
    desired = false;
    reason = 'observe_only';
    bypass = false;
  }

  // ── Anti-court-cycle (sauf bypass) ──
  if (!bypass && relayOn !== null && desired !== relayOn) {
    if (desired) {
      const okOff = state.lastOffTs === null || now - state.lastOffTs >= config.minOffSec * SEC;
      const okCycle =
        state.lastTransitionTs === null ||
        now - state.lastTransitionTs >= config.antiCyclingSec * SEC;
      if (!(okOff && okCycle)) {
        desired = relayOn;
        reason = 'anticycle_hold';
        note = 'maintien (anti-court-cycle)';
      }
    } else {
      const okOn = state.lastOnTs === null || now - state.lastOnTs >= config.minOnSec * SEC;
      if (!okOn) {
        desired = relayOn;
        reason = 'anticycle_hold';
        note = 'maintien (durée min ON)';
      }
    }
  }

  // ── Tampon des horodatages de transition (vrai changement d'ordre) ──
  if (relayOn !== null && desired !== relayOn) {
    next.lastTransitionTs = now;
    if (desired) next.lastOnTs = now;
    else next.lastOffTs = now;
  }

  const subMode = subModeFor(reason, desired);
  next.relayDesired = desired;
  next.lastReason = reason;
  next.lastSubMode = subMode;
  next.anomaly = anomaly;

  return {
    relayDesired: desired,
    reason,
    subMode,
    anomaly,
    surplusW,
    note,
    apply: true,
    nextState: next
  };
}
