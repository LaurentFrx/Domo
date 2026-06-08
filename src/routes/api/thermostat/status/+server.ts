/**
 * Proxy serveur (lecture) vers thermostat-bridge — daemon de régulation du
 * sèche-serviette (RPi4), exposé en loopback sur le VPS via tunnel SSH inverse.
 *
 * Le bridge ne doit PAS être exposé au navigateur ni à Internet. Le client tape
 * /api/thermostat/status (derrière le guard d'auth de hooks.server.ts) et
 * SvelteKit relaie en server-to-server. Tant que le daemon n'est pas déployé,
 * cette route renvoie une erreur et le store bascule en « hors ligne ».
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => {
  const u = env.THERMOSTAT_BRIDGE_URL;
  if (!u) throw error(503, 'THERMOSTAT_BRIDGE_URL non configurée');
  return u.replace(/\/+$/, '');
};
const TIMEOUT_MS = 8_000;

export const GET: RequestHandler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/status`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `thermostat-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);

  if (!upstream.ok) throw error(502, `thermostat-bridge: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'thermostat-bridge: JSON invalide');
  return json(data);
};
