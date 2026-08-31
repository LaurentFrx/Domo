/**
 * Collecte des entrées du moteur cumulus (server-side, sans passer par les routes
 * /api gardées par auth).  Lit en parallèle : relais (Shelly), EM-50 (surplus +
 * conso), prévision PV (prochain créneau diurne), sonde température (cache MQTT),
 * et le tarif HP/HC (import direct de tariffs.ts). Chaque source porte sa
 * disponibilité pour un repli prudent ; aucune ne lève (échec → indisponible).
 */

import { env } from '$env/dynamic/private';
import { isHC, nextTariffSwitch, parisDate, regimeAt } from '../tariffs';
import type { CumulusConfig, CumulusInputs, TempSource, ApplianceInput } from './types';
import { readRelay } from './relay';
import { readAnkerSolarbank } from '$lib/server/anker-modbus';
import { averageTemp } from './energy-model';
import { ensureTempSensor, getCumulusTemp, ensureTempTopic, getTempTopic } from './temp-sensor';
import { ensureApplianceSensors, getAppliancePower, TRACKED_APPLIANCES } from './appliance-sensor';

const TIMEOUT_MS = 8_000;
const FORECAST_TIMEOUT_MS = 12_000;
const INDOOR_STALE_MS = 3 * 3_600_000; // sonde intérieure périmée au-delà de 3 h
const APPLIANCE_STALE_MS = 10 * 60_000; // prise périmée au-delà de 10 min (plug offline)

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

// Anti-rebond des voies EM-50 (act_power). Une mesure absente/non finie NE DOIT PAS
// être coercée en 0 « sain » (aveuglerait le veto zéro-import sur un CT en défaut
// PERSISTANT) ; mais un null PONCTUEL (glitch de poll / recalibration CT) ne doit pas
// non plus basculer au tick (sinon le pilote LIVE coupe une chauffe établie + brûle un
// quota d'allumage — revue 24/07-4/5). Règle UNIFORME par voie (réseau ET cumulus, le
// glitch cumulus coupait aussi via heatingNow) : on tient la dernière valeur VALIDE
// pendant une grâce ~1 tick, puis on la déclare indisponible. `everGood` évite de
// fabriquer un 0 « sain » AVANT toute lecture valide (boot : 1er poll null → indisponible,
// pas un faux 0). Grâce 45 s < 1 tick (~65 s) → UN poll glitché absorbé (le 1er null est
// toujours tenu), le 2e null consécutif bascule indisponible → exposition (veto + alerte
// engine) bornée à ~1 tick.
const EM50_CHANNEL_GRACE_MS = 45_000;

interface ChanState {
  lastGood: number;
  invalidSinceMs: number | null;
  everGood: boolean;
}
const gridChan: ChanState = { lastGood: 0, invalidSinceMs: null, everGood: false };
const cumulusChan: ChanState = { lastGood: 0, invalidSinceMs: null, everGood: false };

/** Débruite une voie. held=false ⇒ donnée indisponible (jamais eu de valide, ou
 *  défaut persistant > grâce) — l'appelant décide (réseau → muet ; cumulus → 0). */
function debounceChannel(
  st: ChanState,
  raw: unknown,
  nowMs: number
): { held: boolean; value: number } {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    st.lastGood = raw;
    st.invalidSinceMs = null;
    st.everGood = true;
    return { held: true, value: raw };
  }
  if (!st.everGood) return { held: false, value: 0 }; // jamais de vraie lecture (boot)
  if (st.invalidSinceMs === null) st.invalidSinceMs = nowMs;
  if (nowMs - st.invalidSinceMs > EM50_CHANNEL_GRACE_MS) return { held: false, value: 0 }; // persistant
  return { held: true, value: st.lastGood }; // glitch transitoire → dernière valeur valide
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

    const nowMs = Date.now();
    // Débruiter les DEUX voies à CHAQUE tick — évaluer cumulus AVANT le retour anticipé
    // réseau, sinon son timer de grâce GÈLE pendant une panne réseau (les deux voies du
    // même device tombent souvent ensemble) et un glitch cumulus FRAIS au rétablissement
    // serait déclassé « persistant », grâce annulée. `c` reste inutilisé sur le chemin fail
    // mais son état (invalidSinceMs/lastGood/everGood) ne gèle plus. (revue 24/07-6)
    const g = debounceChannel(gridChan, gEm.act_power, nowMs); // réseau : pilote le veto muet
    const c = debounceChannel(cumulusChan, cEm.act_power, nowMs); // cumulus : heatingNow
    // Voie réseau indisponible (jamais valide OU défaut persistant) → compteur muet (veto joue).
    if (!g.held) return fail;
    return {
      available: true,
      gridPowerW: Math.round(gridSign() * g.value),
      cumulusPowerW: Math.round(c.value),
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
  power_w?: { total?: number; paths?: { aps?: number } };
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

/** Production PRÉVUE du seul chemin APS (pan Sud). Sert à estimer ce que notre
 *  bridage lui interdit de produire : la mesure ne peut pas le dire, elle EST le
 *  bridage. `null` = le pont ne détaille pas les chemins. */
function pointApsW(pt: ForecastPoint): number | null {
  const v = pt.power_w?.paths?.aps;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null;
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
  d1Kwh: number; // énergie prévue demain, journée complète (kWh) ; −1 si inconnue
  d2Kwh: number; // énergie prévue après-demain (kWh) ; −1 si inconnue
  apsNowW: number | null; // production APS PRÉVUE à l'heure courante (W) ; null si inconnue
}> {
  const fail = {
    available: false,
    kwh: 0,
    outdoorC: null,
    d1Kwh: -1,
    d2Kwh: -1,
    apsNowW: null
  };
  const base = forecastUrl();
  if (!base) return fail;
  try {
    const r = await fetch(`${base}/api/forecast`, {
      signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS)
    });
    if (!r.ok) return fail;
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

    // Température extérieure et potentiel APS : point de l'HEURE COURANTE
    // (aujourd'hui), indépendants de la fenêtre de production ci-dessous.
    let outdoorC: number | null = null;
    let apsNowW: number | null = null;
    for (const pt of arr) {
      const time = typeof pt.time === 'string' ? pt.time : '';
      if (time.slice(0, 10) !== today || Number(time.slice(11, 13)) !== h) continue;
      if (typeof pt.temp === 'number' && Number.isFinite(pt.temp)) outdoorC = pt.temp;
      apsNowW = pointApsW(pt);
      break;
    }

    // Agrégats J+1 / J+2 (journées calendaires complètes) — modulation de la recharge HC
    // nocturne UNIQUEMENT (annotation Laurent : prévision sur DEUX jours pour affiner).
    const d1Day = parisDate(new Date(now.getTime() + 86_400_000));
    const d2Day = parisDate(new Date(now.getTime() + 2 * 86_400_000));
    let d1Wh = 0;
    let d2Wh = 0;
    let d1Seen = false;
    let d2Seen = false;
    for (const pt of arr) {
      const day = typeof pt.time === 'string' ? pt.time.slice(0, 10) : '';
      if (day === d1Day) {
        d1Wh += pointPowerW(pt);
        d1Seen = true;
      } else if (day === d2Day) {
        d2Wh += pointPowerW(pt);
        d2Seen = true;
      }
    }
    const d1Kwh = d1Seen ? +(d1Wh / 1000).toFixed(2) : -1;
    const d2Kwh = d2Seen ? +(d2Wh / 1000).toFixed(2) : -1;

    if (arr.length) {
      let wh = 0;
      for (const pt of arr) {
        const time = typeof pt.time === 'string' ? pt.time : '';
        if (time.slice(0, 10) !== targetDay) continue;
        const ph = Number(time.slice(11, 13));
        if (!Number.isFinite(ph) || ph < fromHour || ph >= 19) continue;
        wh += pointPowerW(pt);
      }
      return { available: true, kwh: +(wh / 1000).toFixed(2), outdoorC, d1Kwh, d2Kwh, apsNowW };
    }
    if (typeof d.next_24h_kwh === 'number')
      return { available: true, kwh: d.next_24h_kwh, outdoorC, d1Kwh, d2Kwh, apsNowW };
    return { ...fail, outdoorC, apsNowW };
  } catch {
    return fail;
  }
}

// ── APsystems EZ1 (pan Sud) — invisible côté Anker, lu séparément (bridge :8100) ──
const apsystemsUrl = () =>
  (env.APSYSTEMS_BRIDGE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');

interface ApsRead {
  powerW: number; // production instantanée (0 si indispo)
  available: boolean; // le bridge répond ET se dit disponible
  ageSec: number | null; // fraîcheur de la donnée (now − ts), null si ts absent
  capW: number | null; // plafond de bridage EN COURS (null = aucun bail actif)
  maxLimitW: number | null; // plafond matériel maximal de l'onduleur
}

/** Production du micro-onduleur APS EZ1 (pan Sud) + disponibilité/fraîcheur
 *  (l'alerte « APS muet » a besoin de distinguer « injoignable » de « 0 W réel »)
 *  + BAIL DE BRIDAGE : depuis le 27/07 notre propre anti-injection plafonne cet
 *  onduleur, et sa production cesse alors de mesurer le soleil. Qui lit `powerW`
 *  doit pouvoir savoir qu'il regarde un chiffre que NOUS avons fabriqué. */
async function readApsystems(nowMs: number): Promise<ApsRead> {
  const fail: ApsRead = {
    powerW: 0,
    available: false,
    ageSec: null,
    capW: null,
    maxLimitW: null
  };
  try {
    const r = await fetch(`${apsystemsUrl()}/api/apsystems/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return fail;
    const d = (await r.json()) as {
      available?: boolean;
      power_w?: number;
      ts?: number;
      max_power_limit_w?: number;
      cap_lease?: { active?: boolean; cap_w?: number };
    };
    const ageSec =
      typeof d.ts === 'number' && Number.isFinite(d.ts)
        ? Math.max(0, Math.round(nowMs / 1000 - d.ts))
        : null;
    const maxLimitW = Number.isFinite(num(d.max_power_limit_w))
      ? Math.max(0, Math.round(num(d.max_power_limit_w)))
      : null;
    const capW =
      d.cap_lease?.active === true && Number.isFinite(num(d.cap_lease.cap_w))
        ? Math.max(0, Math.round(num(d.cap_lease.cap_w)))
        : null;
    if (d.available === false) return { ...fail, ageSec, capW, maxLimitW };
    return {
      powerW: Math.max(0, Math.round(num(d.power_w))),
      available: true,
      ageSec,
      capW,
      maxLimitW
    };
  } catch {
    return fail;
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
  /** Variantes SANS la Max AC (A17E2) : depuis la reconfig des systèmes Anker
   *  (22/07), le cloud liste AUSSI la Max AC dans batteries[] — quand la
   *  lecture Modbus locale est up, elle PRIME et l'entrée cloud est
   *  dédupliquée via ces champs (sinon la Max AC compterait double). */
  socPctNoMaxAc: number[];
  batteryEnergyWhNoMaxAc: number;
  batteryCapacityWhNoMaxAc: number;
  sbInputW: (number | null)[]; // PV entrant par station (input_power_w) — calibration estimateur
  /** Charge DC des SB3 (W ≥ 0) — surplus solaire RÉORIENTABLE vers le ballon.
   *  Dérivée (les champs cloud charging_power_w sont cassés), cf. sb3ChargeFrom(). */
  sb3ChargeW: number;
}

/**
 * Charge DC des SolarBank 3 (hors Max AC), en W ≥ 0.
 *
 * Les champs cloud `charging_power_w` par station valent ≈ TOUJOURS 0 : la charge des
 * SB3 était donc invisible du pilote, qui ne comptait comme surplus réorientable que la
 * charge Max AC + le don réseau. Or sous régulation zéro-export, quand la maison demande
 * plus, la SolarBank bascule de « charge batterie » vers « sortie AC » : cette puissance
 * est bien réorientable vers le ballon, au même titre que celle de la Max AC.
 * (Constaté le 25/07 : pilote 945 W vus vs ~2300 W réellement réorientables → jamais
 * déclenché de la journée.)
 *
 * On la dérive donc du bilan physique de chaque station : PV entrant (DC) − sortie AC,
 * BORNÉE par la place restante du pack — un pack quasi plein ne peut pas absorber son PV,
 * il le passe en AC (et la sortie AC du cloud est intermittente, d'où la borne). Repli sur
 * l'agrégat DC `solar_power_w` (fiable) ventilé quand le per-station est muet.
 */
const SB3_FILL_HORIZON_H = 0.25; // un pack n'encaisse que la place qui lui reste
function sb3ChargeFrom(
  noMax: {
    soc?: number;
    input_power_w?: number;
    output_power_w?: number;
    battery_capacity_wh?: number;
  }[],
  aggregateDcW: number
): number {
  if (!noMax.length) return 0;
  const perUnitIn = noMax.map((b) => Math.max(0, num(b?.input_power_w)));
  const havePerUnit = perUnitIn.reduce((s, v) => s + v, 0) > 1;
  const share = Math.max(0, aggregateDcW) / noMax.length;
  let total = 0;
  for (let i = 0; i < noMax.length; i++) {
    const b = noMax[i];
    const pvIn = havePerUnit ? perUnitIn[i] : share;
    const net = pvIn - Math.max(0, num(b?.output_power_w));
    if (net <= 0) continue;
    const roomWh = Math.max(0, num(b?.battery_capacity_wh) * (1 - Math.min(1, num(b?.soc) / 100)));
    total += Math.min(net, roomWh / SB3_FILL_HORIZON_H);
  }
  return Math.round(total);
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
    socPct: [],
    socPctNoMaxAc: [],
    batteryEnergyWhNoMaxAc: 0,
    batteryCapacityWhNoMaxAc: 0,
    sbInputW: [],
    sb3ChargeW: 0
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
        model?: string;
        soc?: number;
        battery_energy_wh?: number;
        battery_capacity_wh?: number;
        charging_power_w?: number;
        input_power_w?: number;
        output_power_w?: number;
      }[];
    };
    const bats = Array.isArray(d.batteries) ? d.batteries : [];
    // A17E2 = Solarbank Max AC : exclue des variantes NoMaxAc (sa vérité
    // vient du Modbus local quand il est up — cf. collectInputs).
    const noMax = bats.filter((b) => b?.model !== 'A17E2');
    return {
      available: d.connected !== false,
      pvPowerW: Math.round(num(d.solar_power_w)),
      gridPowerW: Math.round(num(d.grid_power_w)),
      sbOutputPowerW: Math.round(num(d.sb_output_power_w)),
      batteryDischargeW: Math.round(num(d.battery_discharge_power_w)),
      batteryChargeW: Math.round(bats.reduce((s, b) => s + num(b?.charging_power_w), 0)),
      batteryEnergyWh: Math.round(bats.reduce((s, b) => s + num(b?.battery_energy_wh), 0)),
      batteryCapacityWh: Math.round(bats.reduce((s, b) => s + num(b?.battery_capacity_wh), 0)),
      socPct: bats.map((b) => Math.round(num(b?.soc))),
      socPctNoMaxAc: noMax.map((b) => Math.round(num(b?.soc))),
      batteryEnergyWhNoMaxAc: Math.round(noMax.reduce((s, b) => s + num(b?.battery_energy_wh), 0)),
      batteryCapacityWhNoMaxAc: Math.round(
        noMax.reduce((s, b) => s + num(b?.battery_capacity_wh), 0)
      ),
      sbInputW: bats.map((b) =>
        typeof b?.input_power_w === 'number' && Number.isFinite(b.input_power_w)
          ? Math.round(b.input_power_w)
          : null
      ),
      sb3ChargeW: sb3ChargeFrom(noMax, num(d.solar_power_w))
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
  ensureApplianceSensors();
  em.indoorTopics.forEach((topic) => ensureTempTopic(topic));
  if (em.outdoorSources.thermoExtTopic) ensureTempTopic(em.outdoorSources.thermoExtTopic);
  const now = new Date();

  const [relay, em50, forecast, anker, daikinOut, aps, sbLocal] = await Promise.all([
    readRelay(),
    readEm50(),
    readForecastNextDaylight(now),
    readAnker(),
    em.outdoorSources.daikin ? readDaikinOutdoor() : Promise.resolve(null),
    readApsystems(now.getTime()),
    // Max AC en Modbus LOCAL : le bridge cloud ne la liste PAS dans batteries[]
    // → sans elle, socAvg (réserve HC, battFullPct) jugeait un parc « 100 % »
    // avec la batterie principale (7,2 kWh) à moitié vide. Ne rejette jamais.
    readAnkerSolarbank()
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

  // ── Gros consommateurs mesurés (prises Zigbee) : puissance + compteur si frais ──
  const appliances: ApplianceInput[] = TRACKED_APPLIANCES.map((a) => {
    const r = getAppliancePower(a.topic);
    const fresh = r.powerW !== null && r.ageMs !== null && r.ageMs <= APPLIANCE_STALE_MS;
    return {
      name: a.name,
      topic: a.topic,
      onW: a.onW,
      powerW: fresh ? r.powerW : null,
      energyKwh: r.energyKwh
    };
  });

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
    forecastD1Kwh: forecast.d1Kwh,
    forecastD2Kwh: forecast.d2Kwh,
    relayAvailable: relay.available,
    relayOn: relay.on,
    ankerAvailable: anker.available,
    pvPowerW: anker.pvPowerW,
    ankerGridPowerW: anker.gridPowerW,
    sbOutputPowerW: anker.sbOutputPowerW,
    batteryDischargeW: anker.batteryDischargeW,
    // Parc RÉEL : packs cloud + Max AC. Depuis la reconfig des systèmes
    // (22/07), le cloud liste AUSSI la Max AC → quand le Modbus local est up,
    // il PRIME pour elle (fraîcheur) et l'entrée cloud est DÉDUPLIQUÉE
    // (variantes NoMaxAc) ; local down = cloud complet tel quel. Le pilote
    // moyenne batterySocPct (socAvg) : conditions battFullPct / réserve HC
    // fidèles à la vraie réserve. Les flux W restent l'agrégat cloud.
    batterySocPct: sbLocal.available ? [...anker.socPctNoMaxAc, sbLocal.soc_pct] : anker.socPct,
    batteryEnergyWh: sbLocal.available
      ? anker.batteryEnergyWhNoMaxAc + sbLocal.energy_wh
      : anker.batteryEnergyWh,
    batteryCapacityWh: sbLocal.available
      ? anker.batteryCapacityWhNoMaxAc + sbLocal.rated_energy_wh
      : anker.batteryCapacityWh,
    batteryChargeW: anker.batteryChargeW,
    // ── Max AC locale (Modbus ~2,5 s) : le signal « saturation/réserve » du pilote ──
    // battery_power_w est SIGNÉ (+ décharge vers la maison / − charge) → la charge
    // réorientable vers le ballon = max(0, −battery_power_w).
    maxAcAvailable: sbLocal.available,
    maxAcSocPct: sbLocal.available ? sbLocal.soc_pct : null,
    maxAcChargeW: sbLocal.available ? Math.max(0, -sbLocal.battery_power_w) : null,
    // Signé, converti côté AC par le module Modbus (CONV_ETA) : + elle débite,
    // − elle charge. Sert au bilan de charge maison de la réserve du soir.
    maxAcNetW: sbLocal.available ? sbLocal.ac_net_w : null,
    sbInputW: anker.sbInputW,
    sb3ChargeW: anker.sb3ChargeW,
    pvApsW: aps.powerW,
    apsAvailable: aps.available,
    apsAgeSec: aps.ageSec,
    // Ce que NOTRE anti-injection interdit à l'onduleur de produire, et qu'il
    // rendra dès que la chauffe aura absorbé l'injection (la boucle APS remonte
    // son plafond au maximum sur le premier soutirage). Borné par les deux
    // sources qui ne dépendent pas du bridage : le plafond matériel qu'il
    // n'atteint pas, et la prévision météo du pan Sud. 0 = aucun bail actif.
    apsRecoverableW:
      aps.capW !== null && aps.maxLimitW !== null
        ? Math.max(
            0,
            Math.round(
              Math.min(
                aps.maxLimitW - aps.capW,
                forecast.apsNowW === null
                  ? aps.maxLimitW - aps.capW
                  : Math.max(0, forecast.apsNowW - aps.powerW)
              )
            )
          )
        : 0,
    indoorC,
    outdoorC,
    indoorSources,
    outdoorSources,
    appliances
  };
}
