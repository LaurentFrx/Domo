/**
 * Moteur de la boucle de bridage APS — tick impur (lecture, décision, écriture).
 *
 * Sécurités structurelles :
 *  - DÉSACTIVÉE par défaut, et en OBSERVATION quand on l'active : elle journalise
 *    le plafond qu'elle AURAIT écrit sans rien commander. Passage au réel explicite.
 *  - à l'arrêt (désactivation) elle REND le plafond au maximum : jamais d'onduleur
 *    laissé bridé par une boucle qui ne tourne plus.
 *  - deux échecs d'écriture consécutifs → auto-désactivation + restauration.
 *  - toute la logique de décision est dans decide.ts (pure, testée).
 */
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { readJsonSafe, writeJsonAtomic, withFileLock } from '$lib/server/atomic-store';
import { decideAps } from './decide';
import {
  defaultApsLoopConfig,
  defaultApsLoopState,
  type ApsLoopInputs,
  type ApsLoopState
} from './types';

const STATE_FILE = path.join(path.resolve(process.cwd(), 'data'), 'apsloop-state.json');
const BRIDGE = () => (env.APSYSTEMS_BRIDGE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
const EM50 = () => (env.EM50_URL || 'http://127.0.0.1:8102').replace(/\/+$/, '');
const TOKEN = () => env.APS_WRITE_TOKEN || '';
const TIMEOUT = 8_000;
const LOG_MAX = 40;
const CONFIRM_FAIL_MAX = 2;

export interface ApsLogEntry {
  ts: number;
  mode: string;
  writtenW: number | null;
  confirmedW: number | null;
  gridW: number;
  apsW: number;
  maxW: number;
  reason: string;
}

export interface ApsLoopStore {
  enabled: boolean;
  /** true = journalise sans écrire (banc d'observation). */
  observationMode: boolean;
  autoDisabledReason: string | null;
  confirmFailCount: number;
  lastTickTs: number | null;
  lastWriteTs: number | null;
  lastCmdW: number | null;
  loop: ApsLoopState;
  log: ApsLogEntry[];
}

function defaultStore(): ApsLoopStore {
  return {
    enabled: false,
    observationMode: true,
    autoDisabledReason: null,
    confirmFailCount: 0,
    lastTickTs: null,
    lastWriteTs: null,
    lastCmdW: null,
    loop: defaultApsLoopState(),
    log: []
  };
}

function normalize(raw: unknown): ApsLoopStore {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultStore();
  const n = (v: unknown, f: number | null): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : f;
  const loop = (o.loop && typeof o.loop === 'object' ? o.loop : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    observationMode: typeof o.observationMode === 'boolean' ? o.observationMode : d.observationMode,
    autoDisabledReason: typeof o.autoDisabledReason === 'string' ? o.autoDisabledReason : null,
    confirmFailCount: (n(o.confirmFailCount, 0) as number) ?? 0,
    lastTickTs: n(o.lastTickTs, null),
    lastWriteTs: n(o.lastWriteTs, null),
    lastCmdW: n(o.lastCmdW, null),
    loop: {
      exportSinceTs: n(loop.exportSinceTs, null),
      lastWriteTs: n(loop.lastWriteTs, null),
      lastCmdW: n(loop.lastCmdW, null)
    },
    log: Array.isArray(o.log)
      ? (o.log.filter((e) => !!e && typeof e === 'object') as ApsLogEntry[]).slice(-LOG_MAX)
      : []
  };
}

export async function readApsLoop(): Promise<ApsLoopStore> {
  return readJsonSafe(STATE_FILE, {
    fallback: defaultStore,
    normalize,
    label: 'apsloop-state.json'
  });
}

/** Interrupteur. À l'extinction, on REND le plafond au maximum. */
export async function setApsLoopEnabled(enabled: boolean): Promise<ApsLoopStore> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    s.enabled = enabled;
    if (enabled) {
      s.autoDisabledReason = null;
      s.confirmFailCount = 0;
    } else {
      await restoreMax().catch(() => {});
      s.lastCmdW = null;
      s.loop = defaultApsLoopState();
    }
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

export async function setApsLoopObservation(observation: boolean): Promise<ApsLoopStore> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    s.observationMode = observation;
    if (observation) await restoreMax().catch(() => {});
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

interface ApsRead {
  available: boolean;
  powerW: number;
  maxW: number;
  minLimitW: number;
  maxLimitW: number;
  writeEnabled: boolean;
}

async function readAps(): Promise<ApsRead | null> {
  try {
    const r = await fetch(`${BRIDGE()}/api/apsystems/status`, {
      signal: AbortSignal.timeout(TIMEOUT)
    });
    if (!r.ok) return null;
    const d = (await r.json()) as Record<string, unknown>;
    const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
    return {
      available: d.available === true,
      powerW: num(d.power_w, 0),
      maxW: num(d.max_power_w, 960),
      minLimitW: num(d.min_power_w, 30),
      maxLimitW: num(d.max_power_limit_w, 960),
      writeEnabled: d.write_enabled === true
    };
  } catch {
    return null;
  }
}

async function readGrid(): Promise<{ available: boolean; gridW: number }> {
  try {
    const r = await fetch(`${EM50()}/rpc/Shelly.GetStatus`, {
      signal: AbortSignal.timeout(TIMEOUT)
    });
    if (!r.ok) return { available: false, gridW: 0 };
    const d = (await r.json()) as Record<string, { act_power?: number }>;
    const g = d[`em1:${Number(env.EM50_GRID_ID ?? 0)}`];
    const sign = Number(env.EM50_GRID_SIGN ?? 1) < 0 ? -1 : 1;
    if (!g || typeof g.act_power !== 'number' || !Number.isFinite(g.act_power))
      return { available: false, gridW: 0 };
    return { available: true, gridW: Math.round(sign * g.act_power) };
  } catch {
    return { available: false, gridW: 0 };
  }
}

async function writeMax(w: number): Promise<{ ok: boolean; confirmedW: number | null }> {
  const token = TOKEN();
  if (!token) return { ok: false, confirmedW: null };
  try {
    const r = await fetch(`${BRIDGE()}/api/apsystems/maxpower`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_power_w: w }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!r.ok) return { ok: false, confirmedW: null };
    const d = (await r.json()) as { ok?: boolean; confirmed_w?: number | null };
    return {
      ok: d.ok === true,
      confirmedW: typeof d.confirmed_w === 'number' ? d.confirmed_w : null
    };
  } catch {
    return { ok: false, confirmedW: null };
  }
}

/** Rend le plafond au maximum de l'appareil (sortie de boucle, sécurité). */
async function restoreMax(): Promise<void> {
  const aps = await readAps();
  const hi = aps?.maxLimitW ?? 960;
  if (aps && aps.maxW >= hi) return; // déjà au maximum
  await writeMax(hi);
}

export interface ApsTickResult {
  ran: boolean;
  mode: string;
  writtenW: number | null;
  reason: string;
}

export async function apsTick(): Promise<ApsTickResult> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    const now = Date.now();
    s.lastTickTs = now;

    if (!s.enabled) {
      await writeJsonAtomic(STATE_FILE, s);
      return {
        ran: false,
        mode: 'off',
        writtenW: null,
        reason: s.autoDisabledReason ?? 'boucle désactivée'
      };
    }

    const [aps, grid] = await Promise.all([readAps(), readGrid()]);
    if (!aps) {
      await writeJsonAtomic(STATE_FILE, s);
      return { ran: false, mode: 'off', writtenW: null, reason: 'pont APS injoignable' };
    }

    const inputs: ApsLoopInputs = {
      now,
      gridW: grid.gridW,
      em50Available: grid.available,
      apsW: aps.powerW,
      apsAvailable: aps.available,
      apsMaxW: aps.maxW,
      apsMinLimitW: aps.minLimitW,
      apsMaxLimitW: aps.maxLimitW
    };
    const d = decideAps(inputs, defaultApsLoopConfig(), s.loop);
    s.loop = d.nextState;

    let confirmedW: number | null = null;
    if (d.writeW !== null && !s.observationMode) {
      const w = await writeMax(d.writeW);
      confirmedW = w.confirmedW;
      if (w.ok) {
        s.confirmFailCount = 0;
        s.lastWriteTs = now;
        s.lastCmdW = d.writeW;
      } else {
        s.confirmFailCount += 1;
        if (s.confirmFailCount >= CONFIRM_FAIL_MAX) {
          s.enabled = false;
          s.autoDisabledReason = `plafond non appliqué ${s.confirmFailCount}× (demandé ${d.writeW} W)`;
          await restoreMax().catch(() => {});
        }
      }
    }

    const entry: ApsLogEntry = {
      ts: now,
      mode: d.mode,
      writtenW: d.writeW,
      confirmedW,
      gridW: inputs.gridW,
      apsW: inputs.apsW,
      maxW: inputs.apsMaxW,
      reason: d.reason
    };
    if (d.writeW !== null || d.mode !== 'hold') s.log = [...s.log, entry].slice(-LOG_MAX);
    await writeJsonAtomic(STATE_FILE, s);

    // Journal : uniquement les décisions notables. Un tick « hold » toutes les 30 s
    // n'apprend rien et noierait journald (~2 900 lignes/jour).
    if (d.writeW !== null || d.mode !== 'hold')
      console.log(
        `[apsloop]${s.observationMode ? ' OBS' : ''} ${d.mode} | réseau=${inputs.gridW}W APS=${Math.round(inputs.apsW)}W plafond=${inputs.apsMaxW}W` +
          (d.writeW !== null
            ? ` → ${s.observationMode ? 'AURAIT écrit' : 'écrit'} ${d.writeW}W`
            : '') +
          ` | ${d.reason}`
      );
    return { ran: true, mode: d.mode, writtenW: d.writeW, reason: d.reason };
  });
}
