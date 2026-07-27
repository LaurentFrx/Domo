/**
 * POST /api/apsloop/tick — un tick de la boucle de bridage APS.
 *
 * Appelé toutes les 60 s par le timer systemd (curl localhost) SANS cookie
 * Domo. Auth dédiée `Authorization: Bearer <APSLOOP_TICK_TOKEN>` (comparaison
 * à temps constant) ; bypass du guard cookie pour CE chemin exact dans
 * src/hooks.server.ts (modèle /api/cumulus/tick).
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { apsTick } from '$lib/server/apsloop/engine';

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

function tokenMatches(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export const POST: RequestHandler = async ({ request }) => {
  const expected = env.APSLOOP_TICK_TOKEN;
  if (!expected) return json({ error: 'APSLOOP_TICK_TOKEN non configuré' }, { status: 503 });
  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const r = await apsTick();
  return json(r);
};
