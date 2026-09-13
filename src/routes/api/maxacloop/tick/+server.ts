/**
 * POST /api/maxacloop/tick — un tick de la boucle de charge Max AC.
 *
 * Appelé toutes les 20 s par le timer systemd (curl en loopback) SANS cookie.
 * Auth par jeton dédié, comparaison à temps constant, sur le modèle des autres
 * boucles. Le chemin est déclaré dans `AUTH_PAR_JETON` (src/lib/server/access.ts).
 *
 * ⚠️ La cadence n'est pas un détail : en mode « contrôle par un tiers » la Max AC
 * n'a plus de régulation propre, et le chien de garde du RPi4 lui rend la main
 * après ~30 s sans revendication. Un tick plus lent que 30 s ferait donc
 * osciller le système entre pilotage et repli.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { maxAcLoopTick } from '$lib/server/maxacloop/engine';

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
  const expected = env.MAXACLOOP_TICK_TOKEN;
  if (!expected) return json({ error: 'MAXACLOOP_TICK_TOKEN non configuré' }, { status: 503 });
  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  return json(await maxAcLoopTick());
};
