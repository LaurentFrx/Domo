/**
 * Collecte des entrées du moteur cumulus (server-side, sans passer par les routes
 * /api gardées par auth).  Lit en parallèle : relais (Shelly), EM-50 (surplus +
 * conso), prévision PV (prochain créneau diurne), sonde température (cache MQTT),
 * et le tarif HP/HC (import direct de tariffs.ts). Chaque source porte sa
 * disponibilité pour un repli prudent ; aucune ne lève (échec → indisponible).
 */

import { env } from '$env/dynamic/private';
import { isHC, nextTariffSwitch, parisDate, regimeAt } from '../tariffs';
import type { CumulusConfig, CumulusInputs, TempSource, PlanForecastPoint } from './types';
import { readRelay } from './relay';
import { averageTemp } from './energy-model';
import { ensureTempSensor, getCumulusTemp, ensureTempTopic, getTempTopic } from './temp-sensor';

const TIMEOUT_MS = 8_000;
const FORECAST_TIMEOUT_MS = 12_000;
const INDOOR_STALE_MS = 3 * 3_600_000; // sonde intérieure périmée au-delà de 3 h
const FORECAST_HORIZON_H = 30; // courbe PV à venir conservée pour le planificateur (h)

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
async function readForecastNextDaylight(now: Date): Promise<{
  available: boolean;
  kwh: number;
  outdoorC: number | null;
  hourly: PlanForecastPoint[];
}> {
  const base = forecastUrl();
  if (!base) return { available: false, kwh: 0, outdoorC: null, hourly: [] };
  try {
    const r = await fetch(`${base}/api/forecast`, {
      signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS)
    });
    if (!r.ok) return { available: false, kwh: 0, outdoorC: null, hourly: [] };
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

    // Courbe PV horaire À VENIR (heures ≥ courante, jusqu'à l'horizon) pour le planificateur.
    // hoursAhead = jours d'écart × 24 + (heure du point − heure courante) ; raisonnement en
    // heures locales (dates calendaires en UTC minuit) → pas d'ambiguïté DST.
    const todayMidnight = Date.parse(today);
    const hourly: PlanForecastPoint[] = [];
    for (const pt of arr) {
      const time = typeof pt.time === 'string' ? pt.time : '';
      const ph = Number(time.slice(11, 13));
      const ptDay = Date.parse(time.slice(0, 10));
      if (!Number.isFinite(ph) || Number.isNaN(ptDay) || Number.isNaN(todayMidnight)) continue;
      const hoursAhead = Math.round((ptDay - todayMidnight) / 86_400_000) * 24 + (ph - h);
      if (hoursAhead < 0 || hoursAhead > FORECAST_HORIZON_H) continue;
      hourly.push({ hoursAhead, hour: ph, pvW: Math.round(pointPowerW(pt)) });
    }
    hourly.sort((a, b) => a.hoursAhead - b.hoursAhead);

    if (arr.length) {
      let wh = 0;
      for (const pt of arr) {
        const time = typeof pt.time === 'string' ? pt.time : '';
        if (time.slice(0, 10) !== targetDay) continue;
        const ph = Number(time.slice(11, 13));
        if (!Number.isFinite(ph) || ph < fromHour || ph >= 19) continue;
        wh += pointPowerW(pt);
      }
      return { available: true, kwh: +(wh / 1000).toFixed(2), outdoorC, hourly };
    }
    if (typeof d.next_24h_kwh === 'number')
      return { available: true, kwh: d.next_24h_kwh, outdoorC, hourly };
    return { available: false, kwh: 0, outdoorC, hourly };
  } catch {
    return { available: false, kwh: 0, outdoorC: null, hourly: [] };
  }
}

// ── APsystems EZ1 (pan Sud) — invisible côté Anker, lu séparément (bridge :8100) ──
const apsystemsUrl = () =>
  (env.APSYSTEMS_BRIDGE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');

/** Production instantanée du micro-onduleur APS EZ1 (pan Sud), W. 0 si indispo. */
async function readApsystems(): Promise<number> {
  try {
    const r = await fetch(`${apsystemsUrl()}/api/apsystems/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return 0;
    const d = (await r.json()) as { available?: boolean; power_w?: number };
    return d.available === false ? 0 : Math.max(0, Math.round(num(d.power_w)));
  } catch {
    return 0;
  }
}

// ── Anker SolarBank (PV, batterie, réseau) ──
const ankerUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

interface AnkerRead {
  available: boolean;
  pvPowerW: number;
  gridPowerW: number;
  sbOutputPowerW: number;
  batteryDischargeW: number;
  batteryChargeW: number;
  batteryEnergyWh: number;
  batteryCapacityWh: number;
  socPct: number[];
}

async function readAnker(): Promise<AnkerRead> {
  const fail: AnkerRead = {
    available: false,
    pvPowerW: 0,
    gridPowerW: 0,
    sbOutputPowerW: 0,
    batteryDischargeW: 0,
    batteryChargeW: 0,
    batteryEnergyWh: 0,
    batteryCapacityWh: 0,
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
      batteries?: {
        soc?: number;
        battery_energy_wh?: number;
        battery_capacity_wh?: number;
        charging_power_w?: number;
      }[];
    };
    const bats = Array.isArray(d.batteries) ? d.batteries : [];
    return {
      available: d.connected !== false,
      pvPowerW: Math.round(num(d.solar_power_w)),
      gridPowerW: Math.round(num(d.grid_power_w)),
      sbOutputPowerW: Math.round(num(d.sb_output_power_w)),
      batteryDischargeW: Math.round(num(d.battery_discharge_power_w)),
      batteryChargeW: Math.round(bats.reduce((s, b) => s + num(b?.charging_power_w), 0)),
      batteryEnergyWh: Math.round(bats.reduce((s, b) => s + num(b?.battery_energy_wh), 0)),
      batteryCapacityWh: Math.round(bats.reduce((s, b) => s + num(b?.battery_capacity_wh), 0)),
      socPct: bats.map((b) => Math.round(num(b?.soc)))
    };
  } catch {
    return fail;
  }
}

// ── Température extérieure Daikin (bridge Onecta :8096) ──
const daikinUrl = () => (env.DAIKIN_BRIDGE_URL || 'http://127.0.0.1:8096').replace(/\/+$/, '');

async function readDaikinOutdoor(): Promise<number | null> {
  try {
    const r = await fetch(`${daikinUrl()}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return null;
    const d = (await r.json()) as { units?: { outdoor_temp_c?: number }[] };
    if (!Array.isArray(d.units)) return null;
    for (const u of d.units) {
      if (typeof u.outdoor_temp_c === 'number' && Number.isFinite(u.outdoor_temp_c)) {
        return u.outdoor_temp_c;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Nom court d'un topic de sonde pour le log : 'zigbee2mqtt/Thermo SdB' → 'SdB'. */
const topicLabel = (t: string): string =>
  t.replace(/^zigbee2mqtt\//, '').replace(/^[Tt]hermo[_ ]?/, '') || t;

/** Assemble l'instantané d'entrées passé à decide(). */
export async function collectInputs(config: CumulusConfig): Promise<CumulusInputs> {
  const em = config.energyModel;
  ensureTempSensor();
  em.indoorTopics.forEach((topic) => ensureTempTopic(topic));
  if (em.outdoorSources.thermoExtTopic) ensureTempTopic(em.outdoorSources.thermoExtTopic);
  const now = new Date();

  const [relay, em50, forecast, anker, daikinOut, pvApsW] = await Promise.all([
    readRelay(),
    readEm50(),
    readForecastNextDaylight(now),
    readAnker(),
    em.outdoorSources.daikin ? readDaikinOutdoor() : Promise.resolve(null),
    readApsystems()
  ]);

  const t = getCumulusTemp();
  const stale = t.tempC === null || t.ageMs === null || t.ageMs > config.tempStaleSec * 1000;
  const tempC = stale ? null : +(t.tempC! + config.tempOffsetC).toFixed(1);

  // Lit une sonde MQTT seulement si fraîche (≤ INDOOR_STALE_MS) → valeur ou null.
  const freshTopic = (topic: string): number | null => {
    const r = getTempTopic(topic);
    return r.tempC !== null && r.ageMs !== null && r.ageMs <= INDOOR_STALE_MS ? r.tempC : null;
  };

  // ── Température INTÉRIEURE de référence = moyenne des sondes disponibles ──
  const indoorSources: TempSource[] = [];
  for (const topic of em.indoorTopics) {
    const v = freshTopic(topic);
    if (v !== null) indoorSources.push({ name: topicLabel(topic), tempC: v });
  }
  const indoorC = averageTemp(indoorSources);

  // ── Température EXTÉRIEURE de référence = moyenne (daikin + terrasse + météo) ──
  const outdoorSources: TempSource[] = [];
  if (em.outdoorSources.daikin && daikinOut !== null) {
    outdoorSources.push({ name: 'daikin', tempC: daikinOut });
  }
  if (em.outdoorSources.thermoExtTopic) {
    const v = freshTopic(em.outdoorSources.thermoExtTopic);
    if (v !== null) {
      outdoorSources.push({ name: topicLabel(em.outdoorSources.thermoExtTopic), tempC: v });
    }
  }
  if (em.outdoorSources.forecast && forecast.outdoorC !== null) {
    outdoorSources.push({ name: 'météo', tempC: forecast.outdoorC });
  }
  const outdoorC = averageTemp(outdoorSources);

  const isHCnow = isHC(now);
  const sw = nextTariffSwitch(now);
  const reg = regimeAt(now);

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
    priceHp: reg.hp_eur_kwh,
    priceHc: reg.hc_eur_kwh,
    forecastAvailable: forecast.available,
    solNextDaylightKwh: forecast.kwh,
    forecastHourly: forecast.hourly,
    relayAvailable: relay.available,
    relayOn: relay.on,
    ankerAvailable: anker.available,
    pvPowerW: anker.pvPowerW,
    ankerGridPowerW: anker.gridPowerW,
    sbOutputPowerW: anker.sbOutputPowerW,
    batteryDischargeW: anker.batteryDischargeW,
    batterySocPct: anker.socPct,
    batteryEnergyWh: anker.batteryEnergyWh,
    batteryCapacityWh: anker.batteryCapacityWh,
    batteryChargeW: anker.batteryChargeW,
    pvApsW,
    indoorC,
    outdoorC,
    indoorSources,
    outdoorSources
  };
}
