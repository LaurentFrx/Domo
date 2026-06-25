/**
 * Collecte multi-sources de la température instantanée (un échantillon par
 * capteur). Toutes les sources sont lues côté serveur :
 *   - Zigbee  : cache MQTT chaud (temp-sensor.ts), tenu entre les ticks ;
 *   - Airzone : bridge local /api/status → zones[].roomTemp ;
 *   - Daikin  : bridge → units[].outdoor_temp_c (extérieur) ;
 *   - Météo   : Open-Meteo current=temperature_2m (cache 5 min, ne pas marteler).
 *
 * Robustesse : chaque source est bornée en temps (AbortSignal) et isolée
 * (Promise.allSettled) — une source en panne n'empêche pas d'enregistrer les
 * autres. Les sondes Zigbee dont la dernière valeur est périmée (sonde tombée)
 * sont enregistrées en `null` (trou honnête) plutôt qu'avec une valeur figée.
 */

import { env } from '$env/dynamic/private';
import { ensureTempTopic, getTempTopic } from '$lib/server/cumulus/temp-sensor';
import { ZIGBEE_SENSORS } from './registry';
import type { Sample } from './db';

const FETCH_TIMEOUT_MS = 8_000;
/** Au-delà, une mesure Zigbee est considérée périmée (sonde tombée / drop). */
const STALE_MS = 45 * 60 * 1000;
const METEO_CACHE_MS = 5 * 60 * 1000;

// Sanguinet (Landes) — mêmes coordonnées que /api/weather.
const METEO_LAT = 44.488;
const METEO_LON = -1.076;

/** epoch secondes arrondi à la minute (axe X propre, anti-doublon tick manuel). */
function minuteTs(): number {
  const s = Math.floor(Date.now() / 1000);
  return s - (s % 60);
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function collectZigbee(ts: number): Sample[] {
  return ZIGBEE_SENSORS.map((s) => {
    ensureTempTopic(s.topic);
    const { tempC, ageMs } = getTempTopic(s.topic);
    const fresh = tempC != null && ageMs != null && ageMs <= STALE_MS;
    return { sensor: s.key, ts, tempC: fresh ? tempC : null, ageMs };
  });
}

async function collectAirzone(ts: number): Promise<Sample[]> {
  const base = (env.AIRZONE_BRIDGE_URL || '').replace(/\/+$/, '');
  if (!base) return [];
  const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`airzone HTTP ${res.status}`);
  // Le bridge expose les champs bruts en snake_case (`room_temp`) — comme le
  // store airzone qui mappe `roomTemp: z.room_temp`.
  const data = (await res.json()) as { zones?: { id: number; room_temp?: number | null }[] };
  return (data.zones ?? []).map((z) => ({
    sensor: `airzone:${z.id}`,
    ts,
    tempC: finite(z.room_temp),
    ageMs: 0
  }));
}

async function collectDaikin(ts: number): Promise<Sample[]> {
  const base = (env.DAIKIN_BRIDGE_URL || '').replace(/\/+$/, '');
  if (!base) return [];
  const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`daikin HTTP ${res.status}`);
  const data = (await res.json()) as { units?: { outdoor_temp_c?: number }[] };
  // Les unités partagent le groupe extérieur → on prend la 1re valeur finie.
  let outdoor: number | null = null;
  for (const u of data.units ?? []) {
    const v = finite(u.outdoor_temp_c);
    if (v != null) {
      outdoor = v;
      break;
    }
  }
  return outdoor == null ? [] : [{ sensor: 'daikin:outdoor', ts, tempC: outdoor, ageMs: 0 }];
}

let meteoCache: { ts: number; tempC: number | null } | null = null;

async function collectMeteo(ts: number): Promise<Sample[]> {
  const now = Date.now();
  if (!meteoCache || now - meteoCache.ts > METEO_CACHE_MS) {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${METEO_LAT}&longitude=${METEO_LON}&current=temperature_2m`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
    const d = (await res.json()) as { current?: { temperature_2m?: number } };
    meteoCache = { ts: now, tempC: finite(d.current?.temperature_2m) };
  }
  if (meteoCache.tempC == null) return [];
  return [{ sensor: 'meteo:sanguinet', ts, tempC: meteoCache.tempC, ageMs: now - meteoCache.ts }];
}

/** Échantillonne toutes les sources ; renvoie 1 ligne par capteur disponible. */
export async function collectAll(): Promise<Sample[]> {
  const ts = minuteTs();
  const settled = await Promise.allSettled([
    collectAirzone(ts),
    collectDaikin(ts),
    collectMeteo(ts)
  ]);
  const out: Sample[] = collectZigbee(ts);
  for (const r of settled) {
    if (r.status === 'fulfilled') out.push(...r.value);
    else console.error('[temps/collect]', r.reason instanceof Error ? r.reason.message : r.reason);
  }
  return out;
}
