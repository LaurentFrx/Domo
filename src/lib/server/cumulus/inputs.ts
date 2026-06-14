/**
 * Collecte des entrées du moteur cumulus (server-side, sans passer par les routes
 * /api gardées par auth).  Lit en parallèle : relais (Shelly), EM-50 (surplus +
 * conso), prévision PV (prochain créneau diurne), sonde température (cache MQTT),
 * et le tarif HP/HC (import direct de tariffs.ts). Chaque source porte sa
 * disponibilité pour un repli prudent ; aucune ne lève (échec → indisponible).
 */

import { env } from '$env/dynamic/private';
import { isHC, nextTariffSwitch, parisDate } from '../tariffs';
import type { CumulusConfig, CumulusInputs } from './types';
import { readRelay } from './relay';
import { ensureTempSensor, getCumulusTemp, ensureIndoorSensor, getIndoorTemp } from './temp-sensor';

const TIMEOUT_MS = 8_000;
const FORECAST_TIMEOUT_MS = 12_000;
const INDOOR_STALE_MS = 3 * 3_600_000; // sonde intérieure périmée au-delà de 3 h

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  hourCycle: 'h23'
});
const parisHour = (d: Date): number => Number(HOUR_FMT.format(d));

// ── EM-50 (réseau + conso cumulus) — même mapping que /api/em50/status ──
const em50Url = () => (env.EM50_URL || 'http://127.0.0.1:8102').replace(/\/+$/, '');
const gridId = () => Number(env.EM50_GRID_ID ?? 0);
const cumulusId = () => Number(env.EM50_CUMULUS_ID ?? 1);
const gridSign = () => (Number(env.EM50_GRID_SIGN ?? 1) < 0 ? -1 : 1);

interface Em50Read {
  available: boolean;
  gridPowerW: number;
  cumulusPowerW: number;
  cumulusKwh: number;
}

async function readEm50(): Promise<Em50Read> {
  const fail: Em50Read = { available: false, gridPowerW: 0, cumulusPowerW: 0, cumulusKwh: 0 };
  try {
    const r = await fetch(`${em50Url()}/rpc/Shelly.GetStatus`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return fail;
    const d = (await r.json()) as Record<string, { act_power?: number; total_act_energy?: number }>;
    const gEm = d[`em1:${gridId()}`];
    const cEm = d[`em1:${cumulusId()}`];
    const cData = d[`em1data:${cumulusId()}`];
    if (!gEm || !cEm) return fail;
    return {
      available: true,
      gridPowerW: Math.round(gridSign() * num(gEm.act_power)),
      cumulusPowerW: Math.round(num(cEm.act_power)),
      cumulusKwh: num(cData?.total_act_energy) / 1000
    };
  } catch {
    return fail;
  }
}

// ── Prévision PV : énergie du prochain créneau diurne à venir ──
const forecastUrl = () => (env.FORECAST_BRIDGE_URL || '').replace(/\/+$/, '');

interface ForecastPoint {
  time?: string;
  power_w?: { total?: number };
  total?: number;
  kw?: number;
  temp?: number; // température extérieure prévue (°C)
}

function pointPowerW(pt: ForecastPoint): number {
  if (pt.power_w && typeof pt.power_w.total === 'number') return pt.power_w.total;
  if (typeof pt.total === 'number') return pt.total;
  if (typeof pt.kw === 'number') return pt.kw * 1000;
  return 0;
}

/**
 * Somme la prod PV prévue du prochain créneau diurne :
 *   - avant 19 h → reste de la journée du jour (heures [max(now,7), 19[)
 *   - après 19 h → journée de demain (heures [7, 19[)
 * Comparaison par préfixe de chaîne sur le `time` ISO local (pas de new Date →
 * zéro ambiguïté DST). Repli sur next_24h_kwh si pas de série horaire.
 */
async function readForecastNextDaylight(
  now: Date
): Promise<{ available: boolean; kwh: number; outdoorC: number | null }> {
  const base = forecastUrl();
  if (!base) return { available: false, kwh: 0, outdoorC: null };
  try {
    const r = await fetch(`${base}/api/forecast`, {
      signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS)
    });
    if (!r.ok) return { available: false, kwh: 0, outdoorC: null };
    const d = (await r.json()) as {
      hourly?: ForecastPoint[];
      points?: ForecastPoint[];
      next_24h_kwh?: number;
    };
    const arr: ForecastPoint[] = Array.isArray(d.hourly)
      ? d.hourly
      : Array.isArray(d.points)
        ? d.points
        : [];
    const h = parisHour(now);
    const today = parisDate(now);
    const targetDay = h < 19 ? today : parisDate(new Date(now.getTime() + 86_400_000));
    const fromHour = h < 19 ? Math.max(h, 7) : 7;

    // Température extérieure : point de l'HEURE COURANTE (aujourd'hui), indépendant
    // de la fenêtre de production ci-dessous.
    let outdoorC: number | null = null;
    for (const pt of arr) {
      const time = typeof pt.time === 'string' ? pt.time : '';
      if (time.slice(0, 10) !== today || Number(time.slice(11, 13)) !== h) continue;
      if (typeof pt.temp === 'number' && Number.isFinite(pt.temp)) outdoorC = pt.temp;
      break;
    }

    if (arr.length) {
      let wh = 0;
      for (const pt of arr) {
        const time = typeof pt.time === 'string' ? pt.time : '';
        if (time.slice(0, 10) !== targetDay) continue;
        const ph = Number(time.slice(11, 13));
        if (!Number.isFinite(ph) || ph < fromHour || ph >= 19) continue;
        wh += pointPowerW(pt);
      }
      return { available: true, kwh: +(wh / 1000).toFixed(2), outdoorC };
    }
    if (typeof d.next_24h_kwh === 'number')
      return { available: true, kwh: d.next_24h_kwh, outdoorC };
    return { available: false, kwh: 0, outdoorC };
  } catch {
    return { available: false, kwh: 0, outdoorC: null };
  }
}

// ── Anker SolarBank (PV, batterie, réseau) — COLLECTE seule (ÉTAPE 1a) ──
// Lu mais AUCUNE décision ne s'en sert encore ; posé pour le modèle E_avail (1b).
const ankerUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

interface AnkerRead {
  available: boolean;
  pvPowerW: number;
  gridPowerW: number;
  sbOutputPowerW: number;
  batteryDischargeW: number;
  socPct: number[];
}

async function readAnker(): Promise<AnkerRead> {
  const fail: AnkerRead = {
    available: false,
    pvPowerW: 0,
    gridPowerW: 0,
    sbOutputPowerW: 0,
    batteryDischargeW: 0,
    socPct: []
  };
  try {
    const r = await fetch(`${ankerUrl()}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return fail;
    const d = (await r.json()) as {
      connected?: boolean;
      solar_power_w?: number;
      grid_power_w?: number;
      sb_output_power_w?: number;
      battery_discharge_power_w?: number;
      batteries?: { soc?: number }[];
    };
    return {
      available: d.connected !== false,
      pvPowerW: Math.round(num(d.solar_power_w)),
      gridPowerW: Math.round(num(d.grid_power_w)),
      sbOutputPowerW: Math.round(num(d.sb_output_power_w)),
      batteryDischargeW: Math.round(num(d.battery_discharge_power_w)),
      socPct: Array.isArray(d.batteries) ? d.batteries.map((b) => Math.round(num(b?.soc))) : []
    };
  } catch {
    return fail;
  }
}

/** Assemble l'instantané d'entrées passé à decide(). */
export async function collectInputs(config: CumulusConfig): Promise<CumulusInputs> {
  ensureTempSensor();
  ensureIndoorSensor(config.energyModel.indoorTopic);
  const now = new Date();

  const [relay, em50, forecast, anker] = await Promise.all([
    readRelay(),
    readEm50(),
    readForecastNextDaylight(now),
    readAnker()
  ]);

  const t = getCumulusTemp();
  const stale = t.tempC === null || t.ageMs === null || t.ageMs > config.tempStaleSec * 1000;
  const tempC = stale ? null : +(t.tempC! + config.tempOffsetC).toFixed(1);

  const ind = getIndoorTemp(config.energyModel.indoorTopic);
  const indoorStale = ind.tempC === null || ind.ageMs === null || ind.ageMs > INDOOR_STALE_MS;
  const indoorC = indoorStale ? null : ind.tempC;

  const isHCnow = isHC(now);
  const sw = nextTariffSwitch(now);

  return {
    now: now.getTime(),
    todayParis: parisDate(now),
    tempC,
    tempAgeMs: t.ageMs,
    em50Available: em50.available,
    gridPowerW: em50.gridPowerW,
    cumulusPowerW: em50.cumulusPowerW,
    cumulusKwh: em50.cumulusKwh,
    isHC: isHCnow,
    minutesToHcEnd: isHCnow ? sw.inMinutes : -1,
    forecastAvailable: forecast.available,
    solNextDaylightKwh: forecast.kwh,
    relayAvailable: relay.available,
    relayOn: relay.on,
    ankerAvailable: anker.available,
    pvPowerW: anker.pvPowerW,
    ankerGridPowerW: anker.gridPowerW,
    sbOutputPowerW: anker.sbOutputPowerW,
    batteryDischargeW: anker.batteryDischargeW,
    batterySocPct: anker.socPct,
    indoorC,
    indoorAgeMs: ind.ageMs,
    outdoorC: forecast.outdoorC
  };
}
