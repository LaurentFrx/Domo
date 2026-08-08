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
import { isAuthenticated } from '$lib/server/auth';
import { createRateLimiter } from '$lib/server/rate-limit';

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
// Fenêtre glissante. Cet endpoint est le SEUL joignable sans cookie : il mérite
// sa propre limite. 6/min couvre largement un usage raccourci iPhone.
//
// La mécanique vit désormais dans `$lib/server/rate-limit` (partagée avec la
// connexion par PIN) ; seuil, fenêtre et clé sont INCHANGÉS ici, et le seau est
// propre à cette route. Note connue : la clé reste `getClientAddress()`, qui
// derrière Caddy vaut toujours 127.0.0.1 — cette limite est donc globale, pas
// par appelant. C'était déjà le cas ; la corriger changerait le comportement de
// cet endpoint, ce qui n'est pas l'objet de ce lot.
const limiteur = createRateLimiter({ windowMs: 60_000, max: 6 });

function rateLimited(ip: string): boolean {
  return limiteur.hit(ip).limited;
}

export const POST: RequestHandler = async ({ request, getClientAddress, cookies }) => {
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

  // Auth : Bearer <PORTAIL_TOKEN> (raccourci iPhone) OU cookie de session + en-tête
  // applicatif x-domo-app (anti-CSRF : un site tiers ne peut pas poser cet en-tête
  // custom en cross-origin sans préflight CORS, non accordé ici ; le bouton /pieces le pose).
  const expected = env.PORTAIL_TOKEN;
  const provided = extractBearer(request.headers.get('authorization'));
  const okBearer = !!expected && !!provided && tokenMatches(provided, expected);
  if (!okBearer) {
    const appHeader = request.headers.get('x-domo-app') === '1';
    if (!isAuthenticated(cookies) || !appHeader) {
      console.warn(`[portail] 401 ni bearer valide ni cookie+app (ip=${ip})`);
      return json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
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
