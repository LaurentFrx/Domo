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
import { updateEnergyModel, type EnergyTickResult } from './energy-model';
import { planHeating } from './plan';
import type { AutoMode, DecisionLogEntry, ShadowEvent } from './types';

const TICK_TIMEOUT_MS = 45_000; // < intervalle timer (60 s)
const SHADOW_HEAT_W = 500; // conso EM-50 voie cumulus au-dessus → « en chauffe » (timeline)
const SHADOW_LOG_MAX = 80; // taille du journal shadow (timeline du jour)
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
  observationMode?: boolean;
  anker?: {
    available: boolean;
    pvPowerW: number;
    sbOutputPowerW: number;
    batteryDischargeW: number;
    socPct: number[];
  };
  energy?: EnergyTickResult;
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

  // Journal console à chaque tick (mode observation) — visible dans `journalctl -u domo`.
  console.log(
    `[cumulus] ${decision.reason} relais=${relayOn ? 'ON' : 'off'}` +
      `${config.observationMode ? ' [OBSERVATION]' : ''}` +
      ` eau=${inputs.tempC ?? '?'}°C surplus=${decision.surplusW}W |` +
      ` Anker ${inputs.ankerAvailable ? 'ok' : 'injoignable'}` +
      ` pv=${inputs.pvPowerW}W sbOut=${inputs.sbOutputPowerW}W` +
      ` décharge=${inputs.batteryDischargeW}W soc=[${inputs.batterySocPct.join('/')}]%` +
      ` — ${decision.note}`
  );

  // ── Estimateur d'énergie du ballon (ÉTAPE 1b — observation pure, aucun pilotage) ──
  const energyTick = updateEnergyModel(inputs, config, next);
  next.energy = energyTick.energy;
  const er = energyTick.result;
  // Instantané d'affichage pour l'UI (lecture seule ; aucune influence sur la décision).
  next.energyView = {
    eAvailWh: er.eAvailWh,
    eFullWh: er.eFullWh,
    showers: +er.showers.toFixed(2),
    tTankC: er.tTankC
  };

  // ── Planificateur prédictif (ÉTAPE 2a — SHADOW : calcule + journalise, ne pilote pas) ──
  if (config.planner.enabled) {
    const socs = inputs.batterySocPct.filter((s) => Number.isFinite(s));
    next.plan = planHeating(
      {
        now,
        eAvailWh: er.eAvailWh,
        eFullWh: er.eFullWh,
        eDoucheWh: er.eDoucheWh,
        isHC: inputs.isHC,
        socPct: socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null,
        forecast: inputs.forecastHourly
      },
      config.planner
    );
    const p = next.plan;
    console.log(
      `[plan] ${p.action} — ${p.reason}` +
        ` (réserve ${p.showers}/${p.floorShowers} douches` +
        `${p.targetHour !== null ? `, cible ${p.targetHour}h` : ''})`
    );
  }

  // ── Timeline SHADOW (journal du jour : plan / chauffe / puisage / plein) ──
  {
    const evs: ShadowEvent[] = [];
    if (next.plan && state.plan?.action !== next.plan.action) {
      evs.push({ ts: now, kind: 'plan', label: next.plan.action, detail: next.plan.reason });
    }
    const heatingNow = inputs.em50Available && inputs.cumulusPowerW > SHADOW_HEAT_W;
    if (heatingNow && state.shadowHeat === null) {
      next.shadowHeat = { sinceTs: now, sinceInjWh: er.injWhDay };
      evs.push({ ts: now, kind: 'heat_start', label: 'chauffe', detail: '' });
    } else if (!heatingNow && state.shadowHeat !== null) {
      const durMin = Math.round((now - state.shadowHeat.sinceTs) / 60_000);
      const kwh = ((er.injWhDay - state.shadowHeat.sinceInjWh) / 1000).toFixed(2);
      evs.push({
        ts: now,
        kind: 'heat_end',
        label: 'chauffe finie',
        detail: `${durMin} min · ${kwh} kWh`
      });
      next.shadowHeat = null;
    }
    if (er.drawEvent) {
      evs.push({
        ts: now,
        kind: 'draw',
        label: 'puisage',
        detail: `−${er.drawEvent.eDrawnWh} Wh (${er.drawEvent.dropC}°C)`
      });
    }
    if (er.anchored && next.energy.lastAnchorTs !== state.energy.lastAnchorTs) {
      evs.push({ ts: now, kind: 'full', label: 'ballon plein', detail: 'recalage E_avail' });
    }
    if (evs.length) next.shadowLog = [...state.shadowLog, ...evs].slice(-SHADOW_LOG_MAX);
  }

  const fmtSrc = (s: { name: string; tempC: number }[]) =>
    s.length ? s.map((x) => `${x.name} ${x.tempC}`).join(' + ') : 'repli';
  console.log(
    `[energy] E_avail=${er.eAvailWh} Wh (~${er.showers.toFixed(1)} douches)` +
      ` inj=${Math.round(er.injWhDay)} loss=${Math.round(er.lossWhDay)} draw=${Math.round(er.drawWhDay)} |` +
      ` T_tank≈${er.tTankC}°C T_inlet=${er.tInletC}°C |` +
      ` T_room=${inputs.indoorC ?? '?'}°C (${fmtSrc(inputs.indoorSources)})` +
      ` ext=${inputs.outdoorC ?? '?'}°C (${fmtSrc(inputs.outdoorSources)}) |` +
      ` dernier plein ${er.hoursSinceAnchor === null ? 'jamais' : er.hoursSinceAnchor.toFixed(1) + 'h'}` +
      `${er.anchored ? ' [ANCHOR→plein]' : ''}` +
      `${er.drawEvent ? ` [PUISAGE drop=${er.drawEvent.dropC}°C −${er.drawEvent.eDrawnWh}Wh]` : ''}`
  );

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
    note: decision.note,
    observationMode: config.observationMode,
    anker: {
      available: inputs.ankerAvailable,
      pvPowerW: inputs.pvPowerW,
      sbOutputPowerW: inputs.sbOutputPowerW,
      batteryDischargeW: inputs.batteryDischargeW,
      socPct: inputs.batterySocPct
    },
    energy: er
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
  boost?: boolean;
}): Promise<TickResult> {
  const state = await readCumulusState();
  if (cmd.autoMode) {
    state.autoMode = cmd.autoMode;
    if (cmd.autoMode === 'auto') state.boostUntilFull = false; // repasser en auto annule un boost
  }
  if (typeof cmd.manualRelayOn === 'boolean') {
    state.manualRelayOn = cmd.manualRelayOn;
    if (state.autoMode !== 'off') state.autoMode = 'manual';
  }
  if (typeof cmd.boost === 'boolean') {
    state.boostUntilFull = cmd.boost;
    if (cmd.boost) state.autoMode = 'auto'; // « Chauffer maintenant » → auto + boost jusqu'au plein
  }
  await writeCumulusState(state);
  return tick(true);
}
