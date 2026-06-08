/**
 * Proxy serveur (écriture) vers thermostat-bridge.
 *
 * POST body : { mode?, preset?, boost_minutes?, clear_override?, config? }
 * Relaie en POST vers {bridge}/command. Tout passe par le node (derrière le
 * guard d'auth) : seul un utilisateur connecté peut piloter le thermostat, le
 * bridge n'est jamais exposé publiquement.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => {
  const u = env.THERMOSTAT_BRIDGE_URL;
  if (!u) throw error(503, 'THERMOSTAT_BRIDGE_URL non configurée');
  return u.replace(/\/+$/, '');
};
const TIMEOUT_MS = 10_000;

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `thermostat-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);

  const data = (await upstream.json().catch(() => ({}))) as { detail?: string };
  if (!upstream.ok) {
    const detail = data.detail || `HTTP ${upstream.status}`;
    throw error(502, `thermostat-bridge: ${detail}`);
  }
  return json(data);
};
