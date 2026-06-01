/**
 * Proxy serveur (écriture) vers airzone-bridge.
 *
 * POST body : { zoneId: number, on?: boolean, setpoint?: number, mode?: string }
 * Relaie en PUT vers {bridge}/api/zones/{zoneId}/command. Comme tout passe par
 * le node (derrière le guard d'auth), seul un utilisateur connecté peut piloter
 * la clim — le bridge lui-même n'est plus exposé publiquement.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => (env.AIRZONE_BRIDGE_URL || 'http://127.0.0.1:8097').replace(/\/+$/, '');
const TIMEOUT_MS = 15_000;

export const POST: RequestHandler = async ({ request }) => {
  let body: { zoneId?: number; on?: boolean; setpoint?: number; mode?: string };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  const { zoneId, ...cmd } = body;
  if (typeof zoneId !== 'number') throw error(400, 'zoneId (number) requis');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/api/zones/${zoneId}/command`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `airzone-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);

  const data = (await upstream.json().catch(() => ({}))) as { detail?: string };
  if (!upstream.ok) {
    const detail = data.detail || `HTTP ${upstream.status}`;
    throw error(upstream.status === 403 ? 403 : 502, `airzone-bridge: ${detail}`);
  }
  return json(data);
};
