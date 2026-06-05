/**
 * Proxy serveur (lecture) vers apsystems-bridge — onduleur APsystems EZ1, via
 * la loopback du VPS (sortie du tunnel SSH inverse, port 8100). Même rôle et
 * même forme que /api/forecast et /api/airzone/status : le bridge ne doit PAS
 * être exposé au navigateur ni à Internet ; le client tape
 * /api/apsystems/status (derrière le guard d'auth de hooks.server.ts) et
 * SvelteKit relaie server-to-server. Aucune URL interne ni secret côté client.
 *
 * NB : le bridge répond 200 avec available:false quand l'onduleur dort (nuit).
 * On relaie tel quel ; on n'émet une erreur que si le bridge est injoignable.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const bridgeUrl = () => {
  const u = env.APSYSTEMS_BRIDGE_URL;
  if (!u) throw error(503, 'APSYSTEMS_BRIDGE_URL non configurée');
  return u.replace(/\/+$/, '');
};

const TIMEOUT_MS = 12_000;

export const GET: RequestHandler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/api/apsystems/status`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `apsystems-bridge injoignable (${reason}).`);
  }
  clearTimeout(timer);

  if (!upstream.ok) throw error(502, `apsystems-bridge: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'apsystems-bridge: JSON invalide');
  return json(data);
};
