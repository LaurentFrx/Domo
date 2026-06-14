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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CumulusRuntimeState,
  AutoMode,
  DecisionReason,
  Anomaly,
  DecisionLogEntry,
  EnergyState,
  EnergyView
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
    log: []
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
    drawEvents: 0
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
    drawEvents: numOr(o.drawEvents, d.drawEvents)
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
    log: normLog(o.log)
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

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readCumulusState(): Promise<CumulusRuntimeState> {
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    return normalizeCumulusState(JSON.parse(raw));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultCumulusState();
    // Fichier corrompu : repartir d'un état sûr plutôt que de planter le moteur.
    return defaultCumulusState();
  }
}

export async function writeCumulusState(state: CumulusRuntimeState): Promise<void> {
  await ensureDataDir();
  const clean = normalizeCumulusState(state);
  clean.log = clean.log.slice(-LOG_MAX);
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf-8');
  await fs.rename(tmp, FILE);
}
