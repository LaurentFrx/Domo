import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => {
  const u = env.FORECAST_BRIDGE_URL;
  if (!u) throw error(503, 'FORECAST_BRIDGE_URL non configurée');
  return u.replace(/\/+$/, '');
};

const TIMEOUT_MS = 12_000;

export const GET: RequestHandler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/api/forecast`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `forecast-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);
  if (!upstream.ok) throw error(502, `forecast-bridge: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'forecast-bridge: JSON invalide');
  return json(data);
};
