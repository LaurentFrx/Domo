/**
 * État runtime de l'orchestrateur cumulus — `data/cumulus-state.json`.
 *
 * Persiste entre les ticks ET au travers des redémarrages du service (un deploy
 * ne doit pas réarmer le mode vacances en auto, ni perdre l'anti-cycling, le
 * compteur d'énergie du jour ou le dernier cycle anti-légionellose).
 *
 * Modèle calqué sur planning-store.ts : normalisation défensive + écriture
 * atomique (tmp + rename). Jamais de crash sur fichier absent/corrompu.
 */

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../atomic-store';
import type {
  CumulusRuntimeState,
  AutoMode,
  DecisionReason,
  Anomaly,
  DecisionLogEntry,
  EnergyState,
  EnergyView,
  HeatPlan,
  PlanAction,
  ShadowEvent,
  ApplianceCycle,
  RegretDay
} from './types';
import type { CumulusMode } from '$theme/tokens';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'cumulus-state.json');
const LOG_MAX = 60;

const AUTO_MODES: AutoMode[] = ['auto', 'manual', 'off'];
const SUB_MODES: CumulusMode[] = ['OFF', 'PV', 'HC', 'FORCE'];

export function defaultCumulusState(): CumulusRuntimeState {
  return {
    autoMode: 'auto',
    manualRelayOn: false,
    boostUntilFull: false,
    relayDesired: null,
    lastOnTs: null,
    lastOffTs: null,
    lastTransitionTs: null,
    surplusBelowSinceTs: null,
    lowPowerSinceTs: null,
    ballonCharged: false,
    chargedAtTempC: null,
    onSinceTs: null,
    energyDayDate: '',
    energyTodayKwh: 0,
    lastCumulusKwh: null,
    lastDisinfectTs: null,
    lastTickTs: null,
    lastTempC: null,
    lastReason: 'cold_start',
    lastSubMode: 'OFF',
    anomaly: 'none',
    energy: defaultEnergyState(),
    energyView: null,
    plan: null,
    shadowLog: [],
    shadowHeat: null,
    applianceCycles: {},
    regret: { day: defaultRegretDay(), days: [] },
    log: []
  };
}

function defaultRegretDay(date = ''): RegretDay {
  return {
    date,
    injWh: 0,
    pvWh: 0,
    battWh: 0,
    gridHpWh: 0,
    gridHcWh: 0,
    costRealEur: 0,
    costRefHcEur: 0,
    gainEur: 0
  };
}

/** État initial de l'estimateur d'énergie ballon (ÉTAPE 1b). */
export function defaultEnergyState(): EnergyState {
  return {
    eAvailWh: 0,
    lastUpdateTs: null,
    lastProbeC: null,
    lastProbeTs: null,
    lastAnchorTs: null,
    dayDate: '',
    injWhDay: 0,
    lossWhDay: 0,
    drawWhDay: 0,
    drawEvents: 0,
    wasFull: false,
    drawRefC: null,
    drawRefTs: null,
    tRoomC: null,
    tExtC: null
  };
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const numOr = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d;
const boolOr = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

function normLog(v: unknown): DecisionLogEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is DecisionLogEntry => !!e && typeof e === 'object').slice(-LOG_MAX);
}

function normEnergy(v: unknown): EnergyState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultEnergyState();
  return {
    eAvailWh: numOr(o.eAvailWh, d.eAvailWh),
    lastUpdateTs: numOrNull(o.lastUpdateTs),
    lastProbeC: numOrNull(o.lastProbeC),
    lastProbeTs: numOrNull(o.lastProbeTs),
    lastAnchorTs: numOrNull(o.lastAnchorTs),
    dayDate: typeof o.dayDate === 'string' ? o.dayDate : d.dayDate,
    injWhDay: numOr(o.injWhDay, d.injWhDay),
    lossWhDay: numOr(o.lossWhDay, d.lossWhDay),
    drawWhDay: numOr(o.drawWhDay, d.drawWhDay),
    drawEvents: numOr(o.drawEvents, d.drawEvents),
    wasFull: boolOr(o.wasFull, d.wasFull),
    drawRefC: numOrNull(o.drawRefC),
    drawRefTs: numOrNull(o.drawRefTs),
    tRoomC: numOrNull(o.tRoomC),
    tExtC: numOrNull(o.tExtC)
  };
}

export function normalizeCumulusState(raw: unknown): CumulusRuntimeState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultCumulusState();
  return {
    autoMode: AUTO_MODES.includes(o.autoMode as AutoMode) ? (o.autoMode as AutoMode) : d.autoMode,
    manualRelayOn: boolOr(o.manualRelayOn, d.manualRelayOn),
    boostUntilFull: boolOr(o.boostUntilFull, d.boostUntilFull),
    relayDesired: typeof o.relayDesired === 'boolean' ? o.relayDesired : null,
    lastOnTs: numOrNull(o.lastOnTs),
    lastOffTs: numOrNull(o.lastOffTs),
    lastTransitionTs: numOrNull(o.lastTransitionTs),
    surplusBelowSinceTs: numOrNull(o.surplusBelowSinceTs),
    lowPowerSinceTs: numOrNull(o.lowPowerSinceTs),
    ballonCharged: boolOr(o.ballonCharged, d.ballonCharged),
    chargedAtTempC: numOrNull(o.chargedAtTempC),
    onSinceTs: numOrNull(o.onSinceTs),
    energyDayDate: typeof o.energyDayDate === 'string' ? o.energyDayDate : d.energyDayDate,
    energyTodayKwh: numOr(o.energyTodayKwh, d.energyTodayKwh),
    lastCumulusKwh: numOrNull(o.lastCumulusKwh),
    lastDisinfectTs: numOrNull(o.lastDisinfectTs),
    lastTickTs: numOrNull(o.lastTickTs),
    lastTempC: numOrNull(o.lastTempC),
    lastReason: (o.lastReason as DecisionReason) ?? d.lastReason,
    lastSubMode: SUB_MODES.includes(o.lastSubMode as CumulusMode)
      ? (o.lastSubMode as CumulusMode)
      : d.lastSubMode,
    anomaly: (o.anomaly as Anomaly) ?? d.anomaly,
    energy: normEnergy(o.energy),
    energyView: normEnergyView(o.energyView),
    plan: normPlan(o.plan),
    shadowLog: normShadowLog(o.shadowLog),
    shadowHeat: normShadowHeat(o.shadowHeat),
    applianceCycles: normApplianceCycles(o.applianceCycles),
    regret: normRegret(o.regret),
    log: normLog(o.log)
  };
}

function normRegretDay(v: unknown): RegretDay | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.date !== 'string') return null;
  const d = defaultRegretDay(o.date);
  return {
    date: o.date,
    injWh: numOr(o.injWh, d.injWh),
    pvWh: numOr(o.pvWh, d.pvWh),
    battWh: numOr(o.battWh, d.battWh),
    gridHpWh: numOr(o.gridHpWh, d.gridHpWh),
    gridHcWh: numOr(o.gridHcWh, d.gridHcWh),
    costRealEur: numOr(o.costRealEur, d.costRealEur),
    costRefHcEur: numOr(o.costRefHcEur, d.costRefHcEur),
    gainEur: numOr(o.gainEur, d.gainEur)
  };
}

function normRegret(v: unknown): { day: RegretDay; days: RegretDay[] } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const day = normRegretDay(o.day) ?? defaultRegretDay();
  const days = Array.isArray(o.days)
    ? o.days
        .map(normRegretDay)
        .filter((x): x is RegretDay => x !== null)
        .slice(-30)
    : [];
  return { day, days };
}

function normApplianceCycles(v: unknown): Record<string, ApplianceCycle> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, ApplianceCycle> = {};
  for (const [topic, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.startTs !== 'number' || o.running !== true) continue; // on ne garde que les cycles EN COURS
    out[topic] = {
      running: true,
      startTs: o.startTs,
      startEnergyKwh: numOrNull(o.startEnergyKwh),
      energyWh: numOr(o.energyWh, 0),
      peakW: numOr(o.peakW, 0),
      lastAboveTs: numOr(o.lastAboveTs, o.startTs),
      coHeatTicks: numOr(o.coHeatTicks, 0),
      deferTicks: numOr(o.deferTicks, 0)
    };
  }
  return out;
}

const SHADOW_KINDS = ['plan', 'heat_start', 'heat_end', 'draw', 'full', 'appliance'];
function normShadowLog(v: unknown): ShadowEvent[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (e): e is ShadowEvent =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as ShadowEvent).ts === 'number' &&
        SHADOW_KINDS.includes((e as ShadowEvent).kind)
    )
    .slice(-80);
}

function normShadowHeat(
  v: unknown
): { sinceTs: number; sinceInjWh: number; solar: boolean } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.sinceTs !== 'number' || typeof o.sinceInjWh !== 'number') return null;
  return {
    sinceTs: o.sinceTs,
    sinceInjWh: o.sinceInjWh,
    solar: typeof o.solar === 'boolean' ? o.solar : false
  };
}

function normEnergyView(v: unknown): EnergyView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    eAvailWh: numOr(o.eAvailWh, 0),
    eFullWh: numOr(o.eFullWh, 0),
    showers: numOr(o.showers, 0),
    tTankC: numOr(o.tTankC, 0)
  };
}

const PLAN_ACTIONS: PlanAction[] = ['heat_now', 'heat_hc', 'wait_solar', 'wait'];
function normPlan(v: unknown): HeatPlan | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!PLAN_ACTIONS.includes(o.action as PlanAction)) return null;
  return {
    action: o.action as PlanAction,
    reason: typeof o.reason === 'string' ? o.reason : '',
    targetHour: numOrNull(o.targetHour),
    showers: numOr(o.showers, 0),
    floorShowers: numOr(o.floorShowers, 0),
    deficitWh: numOr(o.deficitWh, 0),
    gridNowW: numOr(o.gridNowW, 0),
    measured: typeof o.measured === 'boolean' ? o.measured : false,
    pvCoverW: numOr(o.pvCoverW, 0),
    batteryCoverW: numOr(o.batteryCoverW, 0),
    gridDrawW: numOr(o.gridDrawW, 0),
    autoconsoPct: numOr(o.autoconsoPct, 0),
    eveningNeedWh: numOr(o.eveningNeedWh, 0),
    storageLossWh: numOr(o.storageLossWh, 0),
    costNowEur: numOr(o.costNowEur, 0),
    costHcEur: numOr(o.costHcEur, 0),
    backstopHcHour: numOrNull(o.backstopHcHour),
    computedAt: numOr(o.computedAt, 0)
  };
}

export async function readCumulusState(): Promise<CumulusRuntimeState> {
  // Corruption → quarantaine + restauration .bak + incident (au lieu d'un défaut
  // muet qui effaçait silencieusement l'anti-cycling / le compteur d'énergie).
  return readJsonSafe(FILE, {
    fallback: defaultCumulusState,
    normalize: normalizeCumulusState,
    label: 'cumulus-state.json'
  });
}

export async function writeCumulusState(state: CumulusRuntimeState): Promise<void> {
  const clean = normalizeCumulusState(state);
  clean.log = clean.log.slice(-LOG_MAX);
  await writeJsonAtomic(FILE, clean);
}
