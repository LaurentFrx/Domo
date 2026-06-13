/**
 * Proxy serveur (lecture) vers daikin-bridge.
 *
 * GET → relaie {bridge}/api/status. Comme tout passe par le node (derrière le
 * guard d'auth), seul un utilisateur connecté peut lire l'état de la clim —
 * le bridge lui-même n'est plus exposé publiquement (Caddy ne laisse passer
 * que le callback OAuth). Le 503 « non configuré » du bridge est relayé tel
 * quel (le store lit body.detail).
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const TIMEOUT_MS = 15_000;

export const GET: RequestHandler = async () => {
  const base = (env.DAIKIN_BRIDGE_URL || '').replace(/\/+$/, '');
  if (!base) {
    return json({ detail: 'DAIKIN_BRIDGE_URL non configurée' }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    return json({ detail: `daikin-bridge injoignable (${reason})` }, { status: 504 });
  }

  const data = await upstream.json().catch(() => ({}));
  // Relais transparent (status + body) : le store gère 503 (unconfigured) etc.
  return json(data, { status: upstream.status });
};
