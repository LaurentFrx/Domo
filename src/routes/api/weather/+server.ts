/**
 * Météo Sanguinet (Landes) — RÉELLE via Open-Meteo (gratuit, sans clé).
 * Remplace le mock `weather.svelte.ts` (outdoorTemp/condition figés).
 *
 * Renvoie l'instant courant (temp, humidité, vent, condition, UV) + une prévision
 * 3 jours (demain → J+3). Fetch server-side (le VPS a Internet) avec petit cache
 * mémoire 5 min (la météo bouge ~à l'heure ; on ne martèle pas l'API publique).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const LAT = 44.488;
const LON = -1.076; // Sanguinet, Landes
const CACHE_MS = 5 * 60 * 1000;

type Condition = 'clear' | 'partly-cloudy' | 'cloudy' | 'rain' | 'thunderstorm';

/** Code météo WMO (Open-Meteo) → condition simplifiée de l'app. */
function wmoToCondition(code: number): Condition {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly-cloudy';
  if (code === 3 || code === 45 || code === 48) return 'cloudy';
  if (code >= 95) return 'thunderstorm';
  // 51-67 bruine/pluie, 71-86 neige/averses → on regroupe en "rain"
  if (code >= 51) return 'rain';
  return 'cloudy';
}

let cache: { ts: number; body: unknown } | null = null;

export const GET: RequestHandler = async ({ fetch }) => {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) {
    return json(cache.body as object);
  }

  // best_match (modèle non forcé) : Open-Meteo prend AROME Météo-France (haute
  // résolution ~1,3 km) pour les variables qu'il produit ET complète avec les
  // modèles globaux pour celles qu'AROME ne fournit pas (uv_index, proba de
  // pluie, weather_code). Forcer meteofrance_seamless renverrait null sur ces
  // variables (testé) → on garde best_match, c'est déjà le mélange optimal.
  // UV : current.uv_index = indice de l'INSTANT (≈ 0 la nuit), et non plus le
  // uv_index_max journalier qui affichait l'UV de midi toute la soirée.
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${LAT}&longitude=${LON}` +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,uv_index' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&timezone=Europe%2FParis&forecast_days=4&wind_speed_unit=kmh';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
    const d = (await res.json()) as {
      current?: Record<string, number>;
      daily?: Record<string, (number | string)[]>;
    };
    const c = d.current ?? {};
    const dy = d.daily ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    // Prévision : demain (index 1) → J+3 (index 3). Index 0 = aujourd'hui.
    const days = (dy.time as string[] | undefined) ?? [];
    const forecast3d = [1, 2, 3]
      .filter((i) => i < days.length)
      .map((i) => ({
        date: days[i],
        tempMin: Math.round(num(dy.temperature_2m_min?.[i])),
        tempMax: Math.round(num(dy.temperature_2m_max?.[i])),
        condition: wmoToCondition(num(dy.weather_code?.[i])),
        pop: Math.round(num(dy.precipitation_probability_max?.[i]))
      }));

    const body = {
      current: {
        tempC: +num(c.temperature_2m).toFixed(1),
        humidity: Math.round(num(c.relative_humidity_2m)),
        windSpeedKmh: Math.round(num(c.wind_speed_10m)),
        windDirection: Math.round(num(c.wind_direction_10m)),
        condition: wmoToCondition(num(c.weather_code)),
        uvIndex: Math.round(num(c.uv_index)) // indice UV de l'instant (best_match)
      },
      forecast3d
    };
    cache = { ts: now, body };
    return json(body);
  } catch (e) {
    // Pas de crash : si Open-Meteo est injoignable, on renvoie le dernier cache
    // ou un 503 que le store gère (il garde son état précédent).
    if (cache) return json(cache.body as object);
    return json({ error: e instanceof Error ? e.message : 'weather error' }, { status: 503 });
  }
};
