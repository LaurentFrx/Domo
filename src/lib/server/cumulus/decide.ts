/**
 * Moteur de décision PUR de l'orchestrateur cumulus — V2 (03/07/2026).
 *
 * `decide(inputs, config, state, pilotWant)` ne fait AUCUNE I/O. Depuis la V2, il
 * ne contient PLUS AUCUNE logique de chauffe : c'est le PILOTE (pilot.ts, machine à
 * phases « règle zéro achat EDF ») qui décide QUAND chauffer. decide() conserve ce
 * qui est au-dessus du pilote et hors de sa portée :
 *
 *   - les commandes utilisateur (manuel / vacances / « Chauffer maintenant ») ;
 *   - les protections : sécurité 70 °C, détection ballon plein (thermostat) vs
 *     panne résistance, anti-court-cycle, relais injoignable ;
 *   - le mode OBSERVATION : le pilote journalise, le relais n'est PAS commandé ;
 *   - la comptabilité (énergie du jour, désinfection tracée, hystérésis de
 *     recharge après un plein).
 *
 * RETIRÉ de la V1 (logique qui achetait du courant à EDF) : le « maintien
 * économique », les seuils de surplus (surplusOnW/OffW), la chauffe de confort
 * automatique (réponse Laurent Q1 : jamais de chauffe plein-tarif de panique),
 * la chauffe HC « renfort météo » legacy (remplacée par le plan nocturne du pilote).
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

/** Ce que le pilote demande pour ce tick (calculé AVANT decide, sur les mesures fraîches). */
export interface PilotWant {
  wantOn: boolean;
  reason: 'solar' | 'hc' | 'wait';
  note: string;
}

/** Sous-mode (couleur UI) déduit de la raison + de l'état du relais. */
function subModeFor(reason: DecisionReason, on: boolean): CumulusMode {
  switch (reason) {
    case 'pilot_solar':
      return 'PV';
    case 'pilot_hc':
      return 'HC';
    case 'manual_on':
    case 'boost':
      return 'FORCE';
    case 'safety_high':
    case 'tank_full':
    case 'vacation_off':
    case 'manual_off':
    case 'observe_only':
    case 'idle':
    case 'pilot_wait':
      return 'OFF';
    default: // cold_start, anticycle_hold
      return on ? 'FORCE' : 'OFF';
  }
}

export function decide(
  inputs: CumulusInputs,
  config: CumulusConfig,
  state: CumulusRuntimeState,
  pilotWant?: PilotWant
): Decision {
  const { now } = inputs;
  const next: CumulusRuntimeState = { ...state };

  const T = inputs.tempC; // °C, déjà corrigé de l'offset ; null = inconnue/périmée
  const tKnown = T !== null;
  next.lastTempC = T;

  // Désinfection : tracée dès que l'eau atteint ≥60 °C (toute chauffe complète). Pas de cycle.
  if (tKnown && (T as number) >= 60) next.lastDisinfectTs = now;

  // Surplus reconstitué (W) — information de journal uniquement (plus aucune décision dessus).
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
      if (d > 0 && d < 5) next.energyTodayKwh = +(next.energyTodayKwh + d).toFixed(3);
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

  // ── Repli : relais injoignable → on ne pilote rien ──
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

  const relayOn = inputs.relayOn;
  let anomaly: Anomaly = tKnown ? 'none' : 'sensor_stale';

  // ── Détection fin de chauffe (ballon plein, thermostat mécanique) vs panne ──
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
      tankFull = true; // conso nulle + eau au moins tiède → le thermostat a coupé
    } else if (onMs >= config.faultConfirmSec * SEC) {
      anomaly = 'heater_fault';
    }
  }

  // ── Arbre de décision ──
  let desired: boolean;
  let reason: DecisionReason;
  let bypass = false; // contourne l'anti-court-cycle (sécurité / override)
  let note = '';

  if (state.autoMode === 'off') {
    desired = false;
    reason = 'vacation_off';
    bypass = true;
    note = 'mode vacances';
  } else if (state.autoMode === 'manual') {
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
    next.chargedAtTempC = T; // consigne réelle apprise du thermostat
    next.boostUntilFull = false;
  } else if (next.boostUntilFull && !next.ballonCharged) {
    desired = true;
    reason = 'boost';
    note = 'chauffe lancée à la demande (jusqu’au plein)';
  } else if (pilotWant) {
    // ── PILOTE V2 : la machine à phases décide (règle zéro achat EDF) ──
    if (pilotWant.wantOn) {
      desired = true;
      reason = pilotWant.reason === 'hc' ? 'pilot_hc' : 'pilot_solar';
    } else {
      desired = false;
      reason = 'pilot_wait';
    }
    note = pilotWant.note;
  } else {
    desired = false;
    reason = 'idle';
    note = 'pilote indisponible — veille';
  }

  // ── Mode OBSERVATION : le pilote journalise, le relais n'est PAS commandé ──
  if (config.observationMode && desired && (reason === 'pilot_solar' || reason === 'pilot_hc')) {
    note = `observation : aurait allumé (${reason}) — relais NON commandé`;
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
