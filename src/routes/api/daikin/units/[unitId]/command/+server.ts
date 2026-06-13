/**
 * Proxy serveur (écriture) vers daikin-bridge.
 *
 * POST body : Command (champs partiels : power, operation_mode, target_*, fan,
 * swing…) — relayé tel quel vers {bridge}/api/units/{unitId}/command. Derrière
 * le guard d'auth Domo : le bridge n'est plus pilotable publiquement.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const TIMEOUT_MS = 15_000;
// unit_id côté bridge : identifiant court (slug). Borne le format pour ne pas
// relayer n'importe quoi dans l'URL upstream.
const UNIT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const POST: RequestHandler = async ({ request, params }) => {
  const unitId = params.unitId;
  if (!UNIT_ID_RE.test(unitId)) throw error(400, 'unitId invalide');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw error(400, 'objet JSON attendu');
  }

  const base = (env.DAIKIN_BRIDGE_URL || '').replace(/\/+$/, '');
  if (!base) throw error(503, 'DAIKIN_BRIDGE_URL non configurée');

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/units/${encodeURIComponent(unitId)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    throw error(504, `daikin-bridge injoignable (${reason}).`);
  }

  const data = (await upstream.json().catch(() => ({}))) as { detail?: string };
  if (!upstream.ok) {
    return json(data, { status: upstream.status });
  }
  return json(data);
};
