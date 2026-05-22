/**
 * Proxy serveur vers l'API Solcast.
 *
 * Pourquoi un proxy : la clé Solcast ne doit JAMAIS atterrir dans le bundle
 * navigateur. Le client tape /api/solcast/forecast et SvelteKit fait
 * l'appel sortant avec l'en-tête Authorization côté Node.
 */

import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import type { ForecastPoint, ForecastResponse } from '$lib/forecast/types';

const SOLCAST_BASE = 'https://api.solcast.com.au/rooftop_sites';
const FORECAST_HOURS = 168; // 7 jours, max gratuit Solcast
const REQUEST_TIMEOUT_MS = 15_000;

/** Format brut renvoyé par Solcast (champ `forecasts`). */
interface SolcastForecastRaw {
  pv_estimate: number;
  pv_estimate10: number;
  pv_estimate90: number;
  period_end: string;
  period: string; // ex. "PT30M"
}

interface SolcastEnvelope {
  forecasts: SolcastForecastRaw[];
}

/** Convertit une durée ISO 8601 type "PT30M" / "PT1H" en secondes. */
function parsePeriodToSeconds(period: string): number {
  // Regex minimaliste, suffisante pour les durées Solcast (heures + minutes).
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(period);
  if (!match) {
    return 1800; // fallback prudent : 30 min
  }
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function mapForecast(raw: SolcastForecastRaw): ForecastPoint {
  return {
    time: new Date(raw.period_end).toISOString(),
    pvEstimate: raw.pv_estimate,
    pvEstimate10: raw.pv_estimate10,
    pvEstimate90: raw.pv_estimate90,
    periodSeconds: parsePeriodToSeconds(raw.period)
  };
}

export const GET: RequestHandler = async () => {
  const apiKey = env.SOLCAST_API_KEY;
  const resourceId = env.SOLCAST_RESOURCE_ID;

  if (!apiKey || !resourceId) {
    throw error(503, 'Solcast non configuré côté serveur (voir .env)');
  }

  const url = `${SOLCAST_BASE}/${resourceId}/forecasts?format=json&hours=${FORECAST_HOURS}`;

  // Timeout via AbortController : fetch natif ne supporte pas `timeout`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `Solcast injoignable (${reason}).`);
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    // Mappage explicite des codes Solcast vers des codes côté client.
    if (upstream.status === 401 || upstream.status === 403) {
      throw error(502, 'Solcast : authentification refusée (vérifier SOLCAST_API_KEY).');
    }
    if (upstream.status === 429) {
      throw error(503, 'Solcast : quota dépassé, réessayer plus tard.');
    }
    throw error(500, `Solcast : réponse inattendue (${upstream.status}).`);
  }

  let envelope: SolcastEnvelope;
  try {
    envelope = (await upstream.json()) as SolcastEnvelope;
  } catch {
    throw error(500, 'Solcast : payload JSON invalide.');
  }

  if (!Array.isArray(envelope.forecasts)) {
    throw error(500, 'Solcast : structure de réponse inattendue.');
  }

  const points = envelope.forecasts.map(mapForecast);
  const body: ForecastResponse = {
    points,
    fetchedAt: new Date().toISOString()
  };

  return json(body, {
    headers: {
      // Cache CDN/SW : 6h, aligné avec le throttle du store client.
      'Cache-Control': 'public, max-age=21600'
    }
  });
};
