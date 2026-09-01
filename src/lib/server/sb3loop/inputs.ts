/**
 * Collecte des entrées de la boucle SB3 — server-side, chaque source isolée
 * (échec → ok:false, jamais de throw) et bornée en temps. Mêmes chemins que
 * les intégrations existantes : EM-50 direct (pattern cumulus/inputs), APS via
 * bridge, Max AC via le module Modbus partagé (partage de vol + micro-cache),
 * cloud via anker-bridge (champs sb3_* ajoutés pour cette boucle).
 */
import { env } from '$env/dynamic/private';
import { calibratedGridW } from '$lib/server/em50-grid';
import { readAnkerSolarbank } from '$lib/server/anker-modbus';
import { sunPosition } from '../cumulus/sun.ts';
import type { Sb3LoopConfig, Sb3LoopInputs } from './types';

const TIMEOUT_MS = 8_000;

const num = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

const em50Url = () => (env.EM50_URL || 'http://127.0.0.1:8102').replace(/\/+$/, '');
const apsUrl = () => (env.APSYSTEMS_BRIDGE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
const ankerUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

async function readEm50(): Promise<Sb3LoopInputs['em50']> {
  try {
    const r = await fetch(`${em50Url()}/rpc/Shelly.GetStatus`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false, gridW: 0 };
    const d = (await r.json()) as Record<string, { act_power?: number }>;
    // Étalonnage centralisé (em50-grid.ts) : la voie 0 sous-lit ~35 W, ce qui
    // faisait piloter cette boucle sur une injection imaginaire.
    const gridW = calibratedGridW(d[`em1:${Number(env.EM50_GRID_ID ?? 0)}`]?.act_power);
    return gridW === null ? { ok: false, gridW: 0 } : { ok: true, gridW };
  } catch {
    return { ok: false, gridW: 0 };
  }
}

async function readAps(): Promise<Sb3LoopInputs['aps']> {
  try {
    const r = await fetch(`${apsUrl()}/api/apsystems/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false, powerW: 0 };
    const d = (await r.json()) as { available?: boolean; power_w?: number };
    // available:false la nuit = un VRAI 0 W (l'onduleur dort), pas une panne.
    return { ok: true, powerW: d.available ? (num(d.power_w) ?? 0) : 0 };
  } catch {
    return { ok: false, powerW: 0 };
  }
}

async function readCloud(now: number): Promise<Sb3LoopInputs['cloud']> {
  const fail: Sb3LoopInputs['cloud'] = {
    ok: false,
    freshS: null,
    sb3OutW: null,
    sb3SocAvg: null,
    sb3Packs: [],
    sb3PresetW: null,
    sb3PvW: null,
    sceneMode: null
  };
  try {
    const r = await fetch(`${ankerUrl()}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return fail;
    const d = (await r.json()) as {
      connected?: boolean;
      last_update?: number;
      sb3_output_power_w?: number;
      sb3_current_preset_w?: number;
      solar_power_w?: number;
      sb3_scene_mode?: number;
      batteries?: { model?: string; soc?: number; battery_capacity_wh?: number }[];
    };
    if (d.connected === false) return fail;
    // A17C5 = Solarbank 3 E2700 Pro. On garde SoC ET capacité par pack : le
    // prorata d'énergie utilisable se calcule pack par pack, pas sur une moyenne.
    const packs = (d.batteries ?? [])
      .filter((b) => b.model === 'A17C5')
      .map((b) => ({ socPct: num(b.soc), capacityWh: num(b.battery_capacity_wh) }))
      .filter(
        (p): p is { socPct: number; capacityWh: number } =>
          p.socPct !== null && p.capacityWh !== null && p.capacityWh > 0
      );
    const socs = packs.map((p) => p.socPct);
    const lu = num(d.last_update);
    return {
      ok: true,
      freshS: lu !== null ? Math.max(0, Math.round(now / 1000 - lu)) : null,
      sb3OutW: num(d.sb3_output_power_w),
      sb3SocAvg: socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null,
      sb3Packs: packs,
      sb3PresetW: num(d.sb3_current_preset_w),
      sb3PvW: num(d.solar_power_w),
      sceneMode: num(d.sb3_scene_mode)
    };
  } catch {
    return fail;
  }
}

export async function collectSb3Inputs(cfg: Sb3LoopConfig): Promise<Sb3LoopInputs> {
  const now = Date.now();
  const [em50, aps, maxacRaw, cloud] = await Promise.all([
    readEm50(),
    readAps(),
    readAnkerSolarbank(),
    readCloud(now)
  ]);
  return {
    now,
    em50,
    aps,
    maxac: maxacRaw.available
      ? {
          ok: true,
          socPct: maxacRaw.soc_pct,
          // ac_power_w (10208) est une SORTIE seule : 0 pendant la charge. Le flux
          // NET signé vient du registre batterie (cf. docs/regulation-energie.md §5).
          acNetW: maxacRaw.ac_net_w,
          ratedEnergyWh: maxacRaw.rated_energy_wh ?? 0
        }
      : { ok: false, socPct: 0, acNetW: 0, ratedEnergyWh: 0 },
    cloud,
    sunElevDeg: sunPosition(now, cfg.latDeg, cfg.lonDeg).elevationDeg
  };
}
