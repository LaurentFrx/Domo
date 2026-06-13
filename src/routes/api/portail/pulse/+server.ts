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

// ─── Rate-limit en mémoire (anti brute-force du token) ────────────────────
// Fenêtre glissante par IP. Cet endpoint est le SEUL joignable sans cookie :
// il mérite sa propre limite. 6/min couvre largement un usage raccourci iPhone.
const RL_WINDOW_MS = 60_000;
const RL_MAX_PER_WINDOW = 6;
const rlHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (rlHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  recent.push(now);
  rlHits.set(ip, recent);
  // GC grossier : purge les IP inactives pour borner la mémoire.
  if (rlHits.size > 500) {
    for (const [k, v] of rlHits) {
      if (v.every((t) => now - t >= RL_WINDOW_MS)) rlHits.delete(k);
    }
  }
  return recent.length > RL_MAX_PER_WINDOW;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  let ip = 'unknown';
  try {
    ip = getClientAddress();
  } catch {
    // adresse indisponible (selon le proxy) — non bloquant
  }

  if (rateLimited(ip)) {
    console.warn(`[portail] 429 rate-limited (ip=${ip})`);
    return json({ ok: false, error: 'rate_limited' }, { status: 429 });
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
