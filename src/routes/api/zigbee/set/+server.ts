/**
 * Commande Zigbee /set (derrière l'auth par cookie + anti-CSRF des hooks).
 * L'allow-list est appliquée côté serveur (zigbee-hub) : seuls lumiere_atelier et
 * l'imprimante sont pilotables ; le Portail a son propre endpoint. Aucun identifiant
 * MQTT côté client (R14).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { zigbeePublishSet } from '$lib/server/zigbee-hub';

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    device?: string;
    payload?: Record<string, unknown>;
  } | null;
  if (
    !body ||
    typeof body.device !== 'string' ||
    !body.payload ||
    typeof body.payload !== 'object'
  ) {
    throw error(400, 'bad_request');
  }
  const ok = zigbeePublishSet(body.device, body.payload);
  return json({ ok });
};
