/**
 * Orchestrateur cumulus — boucle impure `tick()`.
 *
 * Appelée toutes les 60 s par le timer systemd (POST /api/cumulus/tick) :
 *   collecte des entrées → decide() (pur) → application relais (watchdog
 *   toggle_after) → journal → persistance de l'état.
 *
 * Garde-fous :
 *   - mutex `ticking` : pas de ticks concurrents (modèle `pulsing` de mqtt.ts).
 *   - timeout global : un fetch pendu ne bloque pas le verrou.
 *   - idempotence : on n'émet un ordre que si l'état change OU pour ré-armer le
 *     watchdog (ON maintenu) — jamais de martèlement inutile.
 *   - dry-run (`apply=false`) : calcule et journalise sans toucher au relais ni
 *     fausser les compteurs anti-court-cycle.
 */

import { decide } from './decide';
import { collectInputs } from './inputs';
import { readCumulusConfig } from './config';
import { readCumulusState, writeCumulusState } from './state-store';
import { setRelay } from './relay';
import { ensureTempSensor } from './temp-sensor';
import type { AutoMode, DecisionLogEntry } from './types';

const TICK_TIMEOUT_MS = 45_000; // < intervalle timer (60 s)
const LOG_MAX = 60;

export interface TickResult {
  skipped?: 'busy';
  applied: boolean; // un ordre relais a-t-il été émis (vrai changement) ?
  apply: boolean; // la décision était-elle applicable (≠ cold-start) ?
  relayDesired: boolean;
  relayOn: boolean | null;
  reason: string;
  anomaly: string;
  surplusW: number;
  note: string;
}

let ticking = false;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('tick timeout')), ms))
  ]);
}

/** N'empile au journal que les changements (raison / ordre / anomalie) — pas de bruit. */
function appendLog(log: DecisionLogEntry[], e: DecisionLogEntry): DecisionLogEntry[] {
  const last = log[log.length - 1];
  const changed =
    !last ||
    last.reason !== e.reason ||
    last.relayDesired !== e.relayDesired ||
    last.anomaly !== e.anomaly;
  if (!changed) return log;
  return [...log, e].slice(-LOG_MAX);
}

async function runTick(apply: boolean): Promise<TickResult> {
  ensureTempSensor();
  const config = await readCumulusConfig();
  const state = await readCumulusState();
  const inputs = await collectInputs(config);

  const decision = decide(inputs, config, state);
  const next = decision.nextState;
  const now = inputs.now;

  let relayOn = inputs.relayOn;
  let applied = false;

  if (apply && decision.apply && inputs.relayAvailable) {
    const desired = decision.relayDesired;
    const needChange = relayOn !== desired;
    const needRearm = desired === true; // ré-armer le watchdog tant qu'on veut ON
    if (needChange || needRearm) {
      const res = await setRelay(desired, desired ? config.autoOffDelaySec : undefined);
      if (res.ok) {
        applied = needChange;
        if (res.on !== null) relayOn = res.on;
        // La réalité prime : si le boîtier ne suit pas l'ordre (entrée « follow »,
        // reboot Shelly…), on signale un desync plutôt que de marteler.
        if (res.on !== null && res.on !== desired) next.anomaly = 'desync';
      } else {
        next.anomaly = 'relay_unreachable';
      }
    }
  } else if (!apply) {
    // Dry-run : ne pas fausser les compteurs anti-court-cycle ni le dernier ordre.
    next.lastOnTs = state.lastOnTs;
    next.lastOffTs = state.lastOffTs;
    next.lastTransitionTs = state.lastTransitionTs;
    next.relayDesired = state.relayDesired;
  }

  next.lastTickTs = now;
  next.log = appendLog(state.log, {
    ts: now,
    reason: decision.reason,
    relayDesired: decision.relayDesired,
    tempC: inputs.tempC,
    surplusW: decision.surplusW,
    cumulusPowerW: inputs.cumulusPowerW,
    isHC: inputs.isHC,
    anomaly: next.anomaly
  });

  await writeCumulusState(next);

  return {
    applied,
    apply: decision.apply,
    relayDesired: decision.relayDesired,
    relayOn,
    reason: decision.reason,
    anomaly: next.anomaly,
    surplusW: decision.surplusW,
    note: decision.note
  };
}

/**
 * Un tick du moteur. `apply=false` = dry-run (observation sans pilotage).
 * Retourne `skipped:'busy'` si un tick est déjà en cours (pas de concurrence).
 */
export async function tick(apply = true): Promise<TickResult> {
  if (ticking) {
    return {
      skipped: 'busy',
      applied: false,
      apply: false,
      relayDesired: false,
      relayOn: null,
      reason: 'busy',
      anomaly: 'none',
      surplusW: 0,
      note: 'tick déjà en cours'
    };
  }
  ticking = true;
  try {
    return await withTimeout(runTick(apply), TICK_TIMEOUT_MS);
  } finally {
    ticking = false;
  }
}

/**
 * Applique une commande utilisateur (mode auto/manuel/vacances, forçage relais)
 * puis déclenche un tick immédiat pour refléter le changement sans attendre 60 s.
 * Forcer le relais bascule implicitement en mode manuel (hors mode vacances).
 */
export async function applyCommand(cmd: {
  autoMode?: AutoMode;
  manualRelayOn?: boolean;
}): Promise<TickResult> {
  const state = await readCumulusState();
  if (cmd.autoMode) state.autoMode = cmd.autoMode;
  if (typeof cmd.manualRelayOn === 'boolean') {
    state.manualRelayOn = cmd.manualRelayOn;
    if (state.autoMode !== 'off') state.autoMode = 'manual';
  }
  await writeCumulusState(state);
  return tick(true);
}
