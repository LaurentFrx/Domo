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
import { emptyHouseProfile, normalizeHouseProfile, type HouseAccum } from './reserve';
import type {
  CumulusRuntimeState,
  AutoMode,
  DecisionReason,
  Anomaly,
  DecisionLogEntry,
  EnergyState,
  EnergyView,
  PilotState,
  PilotView,
  HcPlan,
  ShadowEvent,
  CriterionSample,
  ApplianceCycle,
  RegretDay
} from './types';
import type { CumulusMode } from '$theme/tokens';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'cumulus-state.json');
const LOG_MAX = 60;
const CRITERION_LOG_MAX = 660; // ~12 h de ticks (65 s) — la journée solaire entière + la soirée

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
    lastRelayNotifiedOn: null,
    importDuringHeatSinceTs: null,
    importAlerted: false,
    lastReason: 'cold_start',
    lastSubMode: 'OFF',
    anomaly: 'none',
    energy: defaultEnergyState(),
    energyView: null,
    pilot: defaultPilotStateStore(),
    pilotView: null,
    shadowLog: [],
    criterionLog: [],
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
    tExtC: null,
    recentProbeC: null,
    recentProbeTs: null,
    cleanSinceRef: false
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
    tExtC: numOrNull(o.tExtC),
    recentProbeC: numOrNull(o.recentProbeC),
    recentProbeTs: numOrNull(o.recentProbeTs),
    cleanSinceRef: boolOr(o.cleanSinceRef, d.cleanSinceRef)
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
    lastRelayNotifiedOn: typeof o.lastRelayNotifiedOn === 'boolean' ? o.lastRelayNotifiedOn : null,
    importDuringHeatSinceTs: numOrNull(o.importDuringHeatSinceTs),
    importAlerted: boolOr(o.importAlerted, d.importAlerted),
    lastReason: (o.lastReason as DecisionReason) ?? d.lastReason,
    lastSubMode: SUB_MODES.includes(o.lastSubMode as CumulusMode)
      ? (o.lastSubMode as CumulusMode)
      : d.lastSubMode,
    anomaly: (o.anomaly as Anomaly) ?? d.anomaly,
    energy: normEnergy(o.energy),
    energyView: normEnergyView(o.energyView),
    pilot: normPilot(o.pilot),
    pilotView: normPilotView(o.pilotView),
    shadowLog: normShadowLog(o.shadowLog),
    criterionLog: normCriterionLog(o.criterionLog),
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

const SHADOW_KINDS = ['phase', 'heat_start', 'heat_end', 'draw', 'full', 'appliance'];
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

function normCriterionLog(v: unknown): CriterionSample[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (e): e is CriterionSample =>
        !!e && typeof e === 'object' && typeof (e as CriterionSample).ts === 'number'
    )
    .map((e) => {
      const o = e as unknown as Record<string, unknown>;
      const wh = (x: unknown): number | null =>
        typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null;
      return {
        ts: numOr(o.ts, 0),
        uParcWh: wh(o.uParcWh),
        eChauffeWh: wh(o.eChauffeWh),
        reserveWh: wh(o.reserveWh),
        besoinWh: wh(o.besoinWh),
        energyOk: boolOr(o.energyOk, false),
        windowOpen: boolOr(o.windowOpen, false),
        legacyOk: boolOr(o.legacyOk, false),
        commonOk: boolOr(o.commonOk, false),
        wantOn: boolOr(o.wantOn, false),
        relayOn: boolOr(o.relayOn, false),
        heating: boolOr(o.heating, false),
        cause: typeof o.cause === 'string' ? (o.cause as CriterionSample['cause']) : 'idle',
        gridW: numOr(o.gridW, 0),
        residualW: wh(o.residualW),
        // Champs du critère de rechargeabilité (31/08) : absents des
        // échantillons écrits avant, d'où le repli `null` / 0.
        rechargeMarginWh: wh(o.rechargeMarginWh),
        rechargeOk: typeof o.rechargeOk === 'boolean' ? o.rechargeOk : null,
        apsRecoverableW: numOr(o.apsRecoverableW, 0)
      };
    })
    .slice(-CRITERION_LOG_MAX);
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
    tTankC: numOr(o.tTankC, 0),
    eDoucheWh: numOr(o.eDoucheWh, 2000),
    lossPerHWh: numOr(o.lossPerHWh, 0),
    relaxAmplitudeC: numOr(o.relaxAmplitudeC, 6),
    relaxTauMin: numOr(o.relaxTauMin, 120)
  };
}

// ── PILOTE V2 : mémoire de la machine + vue UI ──
const CESSION_CAUSES = ['buy', 'hard_buy', 'battery', 'grace_fail'] as const;

function defaultPilotStateStore(): PilotState {
  return {
    condsSinceTs: null,
    buyOverSinceTs: null,
    socStartOfHeat: null,
    startsDate: '',
    solarStartsToday: 0,
    resumesToday: 0,
    lastCessionCause: null,
    lastCessionTs: null,
    hcPlan: null,
    wouldOnSinceTs: null,
    apsLowSinceTs: null,
    apsAlert: 'none',
    sunWindow: null,
    houseProfile: emptyHouseProfile(),
    houseAccum: null,
    residualW: null
  };
}

function normHouseAccum(v: unknown): HouseAccum | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.day !== 'string') return null;
  const hour = Number(o.hour);
  const sumW = Number(o.sumW);
  const n = Number(o.n);
  if (!Number.isFinite(hour) || !Number.isFinite(sumW) || !Number.isFinite(n)) return null;
  return { day: o.day, hour: Math.max(0, Math.min(23, Math.floor(hour))), sumW, n: Math.max(0, n) };
}

function normSunWindow(v: unknown): PilotState['sunWindow'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.forDate !== 'string') return null;
  return {
    forDate: o.forDate,
    startMin: numOr(o.startMin, -1),
    endMin: numOr(o.endMin, -1)
  };
}

function normHcPlan(v: unknown): HcPlan | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.forDate !== 'string' || typeof o.startMin !== 'number') return null;
  return {
    forDate: o.forDate,
    targetWh: numOr(o.targetWh, 0),
    minWh: numOr(o.minWh, 0),
    startMin: numOr(o.startMin, 6),
    endMin: numOr(o.endMin, 450),
    reason: typeof o.reason === 'string' ? o.reason : '',
    computedAt: numOr(o.computedAt, 0)
  };
}

function normPilot(v: unknown): PilotState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = defaultPilotStateStore();
  return {
    condsSinceTs: numOrNull(o.condsSinceTs),
    buyOverSinceTs: numOrNull(o.buyOverSinceTs),
    socStartOfHeat: numOrNull(o.socStartOfHeat),
    startsDate: typeof o.startsDate === 'string' ? o.startsDate : d.startsDate,
    solarStartsToday: numOr(o.solarStartsToday, 0),
    resumesToday: numOr(o.resumesToday, 0),
    lastCessionCause: (CESSION_CAUSES as readonly string[]).includes(o.lastCessionCause as string)
      ? (o.lastCessionCause as PilotState['lastCessionCause'])
      : null,
    lastCessionTs: numOrNull(o.lastCessionTs),
    hcPlan: normHcPlan(o.hcPlan),
    wouldOnSinceTs: numOrNull(o.wouldOnSinceTs),
    apsLowSinceTs: numOrNull(o.apsLowSinceTs),
    apsAlert: ['none', 'unreachable', 'fault'].includes(o.apsAlert as string)
      ? (o.apsAlert as PilotState['apsAlert'])
      : 'none',
    sunWindow: normSunWindow(o.sunWindow),
    residualW: typeof o.residualW === 'number' && Number.isFinite(o.residualW) ? o.residualW : null,
    houseProfile: normalizeHouseProfile(o.houseProfile),
    houseAccum: normHouseAccum(o.houseAccum)
  };
}

const PILOT_PHASES = ['repos', 'allumage', 'chauffe', 'cession', 'plein', 'recharge_hc'] as const;

function normPilotView(v: unknown): PilotView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!(PILOT_PHASES as readonly string[]).includes(o.phase as string)) return null;
  const conds = Array.isArray(o.conds)
    ? o.conds
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          key: typeof c.key === 'string' ? c.key : '',
          label: typeof c.label === 'string' ? c.label : '',
          ok: c.ok === true,
          detail: typeof c.detail === 'string' ? c.detail : ''
        }))
    : [];
  const rescueRaw = (o.rescue && typeof o.rescue === 'object' ? o.rescue : {}) as Record<
    string,
    unknown
  >;
  const rescueState = ['standby_export', 'standby_below', 'armed', 'unavailable'].includes(
    rescueRaw.state as string
  )
    ? (rescueRaw.state as PilotView['rescue']['state'])
    : 'standby_below';
  return {
    phase: o.phase as PilotView['phase'],
    phaseSinceTs: numOr(o.phaseSinceTs, 0),
    wantOn: o.wantOn === true,
    note: typeof o.note === 'string' ? o.note : '',
    conds,
    rescue: {
      state: rescueState,
      detail: typeof rescueRaw.detail === 'string' ? rescueRaw.detail : ''
    },
    apsAlert: ['none', 'unreachable', 'fault'].includes(o.apsAlert as string)
      ? (o.apsAlert as PilotView['apsAlert'])
      : 'none',
    sunWindowStart: typeof o.sunWindowStart === 'string' ? o.sunWindowStart : null,
    sunWindowEnd: typeof o.sunWindowEnd === 'string' ? o.sunWindowEnd : null,
    sunWindowNote: typeof o.sunWindowNote === 'string' ? o.sunWindowNote : '',
    surplusW: numOr(o.surplusW, 0),
    surplusNeedW: numOr(o.surplusNeedW, 0),
    invisibleSurplusW: numOr(o.invisibleSurplusW, 0),
    potTotalW: numOr(o.potTotalW, 0),
    pApsW: numOr(o.pApsW, 0),
    apsRecoverableW: numOr(o.apsRecoverableW, 0),
    tankReserveWh: numOr(o.tankReserveWh, 0),
    rechargeMarginWh:
      typeof o.rechargeMarginWh === 'number' ? Math.round(o.rechargeMarginWh) : null,
    heatNeedWh: typeof o.heatNeedWh === 'number' ? Math.round(o.heatNeedWh) : null,
    socNow: numOrNull(o.socNow),
    socStart: numOrNull(o.socStart),
    solarStartsToday: numOr(o.solarStartsToday, 0),
    resumesToday: numOr(o.resumesToday, 0),
    quota: numOr(o.quota, 2),
    nextAction: typeof o.nextAction === 'string' ? o.nextAction : '',
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
