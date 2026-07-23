/**
 * Moteur de la boucle SB3 — un tick par appel (timer systemd 60 s).
 *
 * Le tick : collecte → decide() (pur) → écriture éventuelle via le bridge
 * (Bearer) → CONFIRMATION immédiate (le bridge relit le schedule posté) →
 * état persisté (atomic-store) + journal. Deux échecs de confirmation
 * consécutifs → boucle AUTO-DÉSACTIVÉE + Web Push (pattern cumulus).
 *
 * Contrôles de dérive Anker :
 *  - canary de schéma (1er tick du jour Paris + démarrage) : champs attendus
 *    du payload cloud présents, sinon désactivation + notif ;
 *  - version de la lib : check quotidien de la release GitHub vs celle
 *    épinglée — NOTIFICATION SEULE, jamais de mise à jour automatique d'une
 *    dépendance qui pilote du matériel.
 */
import { env } from '$env/dynamic/private';
import { readJsonSafe, writeJsonAtomic, withFileLock } from '$lib/server/atomic-store';
import { sendPush } from '$lib/server/monitor/push';
import { parisDate } from '$lib/server/tariffs';
import { collectSb3Inputs } from './inputs';
import { decide } from './decide';
import {
  defaultSb3LoopConfig,
  defaultSb3LoopState,
  type Sb3DecisionLogEntry,
  type Sb3LoopState
} from './types';

import path from 'node:path';

const STATE_FILE = path.join(path.resolve(process.cwd(), 'data'), 'sb3loop-state.json');
const LOG_MAX = 100;
/** Version de anker-solix-api épinglée dans le Dockerfile du bridge. */
const EXPECTED_LIB_VERSION = 'v3.6.3';

const bridgeUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

async function loadState(): Promise<Sb3LoopState> {
  return readJsonSafe(STATE_FILE, {
    fallback: defaultSb3LoopState,
    normalize: (raw: unknown): Sb3LoopState => ({ ...defaultSb3LoopState(), ...(raw as object) }),
    label: 'sb3loop-state'
  });
}

export async function getSb3LoopState(): Promise<Sb3LoopState> {
  return loadState();
}

/** Interrupteur de la tuile : (dés)active la boucle, efface l'auto-disable. */
export async function setSb3LoopEnabled(enabled: boolean): Promise<Sb3LoopState> {
  return withFileLock(STATE_FILE, async () => {
    const s = await loadState();
    s.enabled = enabled;
    if (enabled) {
      s.autoDisabledReason = null;
      s.autoDisabledTs = null;
      s.confirmFailCount = 0;
    }
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

interface WriteResult {
  ok: boolean;
  confirmedW: number | null;
}

async function writePreset(presetW: number): Promise<WriteResult> {
  const token = env.SB3_BRIDGE_WRITE_TOKEN;
  if (!token) return { ok: false, confirmedW: null };
  presetW = Math.round(Math.min(2400, Math.max(0, presetW)));
  try {
    const r = await fetch(`${bridgeUrl()}/api/sb3/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ preset: presetW }),
      signal: AbortSignal.timeout(45_000) // login owner + POST + relecture cloud
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

/** Champs cloud dont dépend la boucle — le canary vérifie leur présence. */
function canaryOk(payload: Record<string, unknown>): string | null {
  if (payload.sb3_output_power_w === undefined) return 'sb3_output_power_w absent';
  if (payload.sb3_current_preset_w === undefined) return 'sb3_current_preset_w absent';
  if (payload.sb3_scene_mode === undefined) return 'sb3_scene_mode absent';
  const bats = payload.batteries;
  if (!Array.isArray(bats)) return 'batteries[] absent';
  const sb3 = bats.filter((b) => (b as { model?: string }).model === 'A17C5') as {
    soc?: unknown;
  }[];
  if (sb3.length < 2) return `batteries A17C5 : ${sb3.length}/2`;
  if (!sb3.every((b) => typeof b.soc === 'number')) return 'soc A17C5 non numérique';
  return null;
}

async function runCanary(): Promise<string | null> {
  try {
    const r = await fetch(`${bridgeUrl()}/api/status`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return `bridge HTTP ${r.status}`;
    return canaryOk((await r.json()) as Record<string, unknown>);
  } catch (e) {
    return `bridge injoignable (${e instanceof Error ? e.message : 'erreur'})`;
  }
}

async function checkLibVersion(): Promise<void> {
  try {
    const r = await fetch(
      'https://api.github.com/repos/thomluther/anker-solix-api/releases/latest',
      {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json' }
      }
    );
    if (!r.ok) return;
    const d = (await r.json()) as { tag_name?: string };
    if (d.tag_name && d.tag_name !== EXPECTED_LIB_VERSION) {
      void sendPush({
        title: '📦 anker-solix-api : nouvelle version',
        body: `${d.tag_name} disponible (épinglée : ${EXPECTED_LIB_VERSION}). Aucune mise à jour automatique — à évaluer avant de toucher au bridge.`,
        tag: 'sb3loop-lib-version',
        severity: 'info',
        url: '/energie'
      });
    }
  } catch {
    /* check best-effort — jamais bloquant */
  }
}

export interface Sb3TickResult {
  ok: boolean;
  enabled: boolean;
  mode: string;
  reason: string;
  houseLoadW: number | null;
  targetW: number | null;
  writtenW: number | null;
  confirmedW: number | null;
  autoDisabledReason: string | null;
}

export async function sb3LoopTick(): Promise<Sb3TickResult> {
  return withFileLock(STATE_FILE, async () => {
    const cfg = defaultSb3LoopConfig();
    const state = await loadState();
    const now = Date.now();
    state.lastTickTs = now;
    const today = parisDate(new Date(now));

    // ── Canary schéma (démarrage + quotidien), AVANT toute décision. ──
    if (state.lastCanaryDayParis !== today) {
      const fault = await runCanary();
      state.lastCanaryDayParis = today;
      if (fault !== null && state.enabled) {
        state.enabled = false;
        state.autoDisabledReason = `canary schéma : ${fault}`;
        state.autoDisabledTs = now;
        void sendPush({
          title: '🛑 Boucle SB3 désactivée',
          body: `Le canary a détecté un changement de schéma cloud : ${fault}. Réactivation manuelle après vérification.`,
          tag: 'sb3loop-disabled',
          severity: 'critical',
          url: '/energie'
        });
      }
    }
    if (state.lastVersionCheckDayParis !== today) {
      state.lastVersionCheckDayParis = today;
      void checkLibVersion();
    }

    if (!state.enabled) {
      await writeJsonAtomic(STATE_FILE, state);
      return result(
        state,
        'off',
        state.autoDisabledReason ?? 'boucle désactivée',
        null,
        null,
        null,
        null
      );
    }

    const inputs = await collectSb3Inputs(cfg);
    const d = decide(inputs, cfg, state);
    state.pendingDeadband = d.pendingDeadband;
    state.pendingDeadbandDir = d.pendingDeadbandDir;

    let writtenW: number | null = null;
    let confirmedW: number | null = null;
    if (d.writeW !== null) {
      const beforeW = state.lastCmdW ?? inputs.cloud.sb3PresetW;
      const w = await writePreset(d.writeW);
      writtenW = d.writeW;
      confirmedW = w.confirmedW;
      const confirmed =
        w.ok && w.confirmedW !== null && Math.abs(w.confirmedW - d.writeW) <= cfg.confirmToleranceW;
      if (confirmed) {
        state.lastCmdW = d.writeW;
        state.lastWriteTs = now;
        state.confirmFailCount = 0;
      } else {
        state.confirmFailCount += 1;
        if (state.confirmFailCount >= cfg.confirmFailMax) {
          state.enabled = false;
          state.autoDisabledReason = `consigne non prise ${state.confirmFailCount}× (écrit ${d.writeW} W, confirmé ${w.confirmedW ?? '—'})`;
          state.autoDisabledTs = now;
          void sendPush({
            title: '🛑 Boucle SB3 désactivée',
            body: `Le cloud Anker ne prend plus les consignes (${state.confirmFailCount}× de suite). La restauration du plan statique sera tentée aux prochains ticks.`,
            tag: 'sb3loop-disabled',
            severity: 'critical',
            url: '/energie'
          });
        }
      }
      pushLog(state, {
        ts: now,
        mode: d.mode,
        reason: d.reason,
        houseLoadW: d.houseLoadW,
        targetW: d.targetW,
        beforeW,
        writtenW,
        confirmedW
      });
    } else if (state.decisions[0]?.mode !== d.mode || state.decisions[0]?.reason !== d.reason) {
      // Journal des changements d'état seulement (pas 1 440 lignes/jour).
      pushLog(state, {
        ts: now,
        mode: d.mode,
        reason: d.reason,
        houseLoadW: d.houseLoadW,
        targetW: d.targetW,
        beforeW: state.lastCmdW ?? inputs.cloud.sb3PresetW,
        writtenW: null,
        confirmedW: null
      });
    }

    await writeJsonAtomic(STATE_FILE, state);
    return result(state, d.mode, d.reason, d.houseLoadW, d.targetW, writtenW, confirmedW);
  });
}

const PARIS_HOUR_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  hourCycle: 'h23'
});

/** Valeur du plan statique (les créneaux posés dans l'app) à l'instant t. */
function staticPlanW(cfg: ReturnType<typeof defaultSb3LoopConfig>, ts: number): number {
  const h = Number(PARIS_HOUR_FMT.format(new Date(ts)));
  const night = h >= cfg.staticNightStartH || h < cfg.staticNightEndH;
  return night ? cfg.staticNightW : cfg.staticDayW;
}

function pushLog(state: Sb3LoopState, entry: Sb3DecisionLogEntry): void {
  state.decisions.unshift(entry);
  if (state.decisions.length > LOG_MAX) state.decisions.length = LOG_MAX;
}

function result(
  state: Sb3LoopState,
  mode: string,
  reason: string,
  houseLoadW: number | null,
  targetW: number | null,
  writtenW: number | null,
  confirmedW: number | null
): Sb3TickResult {
  return {
    ok: true,
    enabled: state.enabled,
    mode,
    reason,
    houseLoadW,
    targetW,
    writtenW,
    confirmedW,
    autoDisabledReason: state.autoDisabledReason
  };
}
