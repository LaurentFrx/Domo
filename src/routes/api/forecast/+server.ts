import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => {
  const u = env.FORECAST_BRIDGE_URL;
  if (!u) throw error(503, 'FORECAST_BRIDGE_URL non configurée');
  return u.replace(/\/+$/, '');
};

const TIMEOUT_MS = 12_000;

// Cache mémoire : la prévision AROME change toutes les 30 min côté bridge, mais
// chaque GET payait le tunnel SSH → RPi4 (~240 ms mesurés) — pour tous les
// clients, à chaque poll de 5 min et à chaque ouverture de page. TTL court
// (2 min) ; en cas de bridge injoignable on ressert l'ancien (≤ 3 h, marqué
// `stale`) plutôt que de casser la carte — la panne reste visible en log.
const TTL_MS = 2 * 60_000;
const STALE_MAX_MS = 3 * 3600_000;
let cache: { at: number; data: unknown } | null = null;

export const GET: RequestHandler = async () => {
  if (cache && Date.now() - cache.at < TTL_MS) return json(cache.data);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response | null = null;
  let failure = '';
  try {
    upstream = await fetch(`${bridgeUrl()}/api/forecast`, { signal: controller.signal });
  } catch (e) {
    failure = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
  }
  clearTimeout(timer);

  if (upstream?.ok) {
    const data = await upstream.json().catch(() => null);
    if (data !== null) {
      cache = { at: Date.now(), data };
      return json(data);
    }
    failure = 'JSON invalide';
  } else if (upstream) {
    failure = `HTTP ${upstream.status}`;
  }

  if (cache && Date.now() - cache.at < STALE_MAX_MS) {
    console.error(`[forecast] bridge en échec (${failure}) — prévision en cache resservie`);
    return json(cache.data, { headers: { 'x-forecast-stale': '1' } });
  }
  throw error(504, `forecast-bridge injoignable (${failure}).`);
};
