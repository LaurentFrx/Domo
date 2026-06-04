/**
 * POST /api/portail/pulse — ouverture du portail depuis l'extérieur.
 *
 * Reproduit côté serveur l'« Impulsion » du bouton /pieces (publish MQTT
 * zigbee2mqtt/Portail/set : ON puis OFF 500ms après), pour être appelable par
 * un raccourci iPhone SANS le cookie d'auth Domo.
 *
 * Auth dédiée : en-tête `Authorization: Bearer <PORTAIL_TOKEN>` (comparaison à
 * temps constant). Le bypass du guard de cookie pour CE chemin exact est dans
 * src/hooks.server.ts. Réservé au POST — un GET ne doit jamais ouvrir le portail
 * (SvelteKit renvoie 405 sur les autres méthodes, aucun handler exporté).
 */

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { pulsePortail } from '$lib/server/mqtt';

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Comparaison à temps constant, sans fuir la différence de longueur. */
function tokenMatches(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  let ip = 'unknown';
  try {
    ip = getClientAddress();
  } catch {
    // adresse indisponible (selon le proxy) — non bloquant
  }

  const expected = env.PORTAIL_TOKEN;
  if (!expected) {
    console.error(`[portail] PORTAIL_TOKEN non configuré — refus (ip=${ip})`);
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    console.warn(`[portail] 401 token absent/invalide (ip=${ip})`);
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await pulsePortail();
    if (result === 'already_pulsing') {
      console.log(`[portail] 200 already_pulsing — ignoré (ip=${ip})`);
      return json({ ok: true, note: 'already_pulsing' });
    }
    console.log(`[portail] 200 pulse OK (ip=${ip})`);
    return json({ ok: true });
  } catch (e) {
    console.error(`[portail] 503 MQTT indisponible (ip=${ip}):`, (e as Error).message);
    return json({ ok: false, error: 'mqtt_unavailable' }, { status: 503 });
  }
};
