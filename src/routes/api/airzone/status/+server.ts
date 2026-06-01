/**
 * Proxy serveur (lecture) vers airzone-bridge — API locale Airzone, sans cloud.
 *
 * Pourquoi un proxy : le bridge ne doit PAS être exposé au navigateur ni à
 * Internet. Le client tape /api/airzone/status (derrière le guard d'auth de
 * hooks.server.ts) et SvelteKit relaie en server-to-server vers le bridge, sur
 * la loopback du VPS (sortie du tunnel SSH inverse). Aucune URL interne ni
 * secret ne transite côté client.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => (env.AIRZONE_BRIDGE_URL || 'http://127.0.0.1:8097').replace(/\/+$/, '');
const TIMEOUT_MS = 12_000;

export const GET: RequestHandler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/api/status`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `airzone-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);

  if (!upstream.ok) throw error(502, `airzone-bridge: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'airzone-bridge: JSON invalide');
  return json(data);
};
