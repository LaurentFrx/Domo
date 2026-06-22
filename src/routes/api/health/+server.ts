import { json } from '@sveltejs/kit';
import { isMqttConnected } from '$lib/server/mqtt';
import type { RequestHandler } from './$types';

/**
 * Santé de la liaison domotique vue du serveur Domo.
 *
 * `mqtt` = le hub MQTT (capteurs Zigbee, sonde cumulus, portail) est-il joignable ?
 * C'est le proxy le plus fiable de « plus aucune connexion avec mon système » :
 * lors d'une coupure des tunnels reverse RPi4, ce flag tombe à false (cf. le
 * watchdog ops/tunnel-watchdog.sh qui répare la cause côté infra).
 *
 * Lecture en mémoire (état du client MQTT singleton) → réponse instantanée,
 * aucun appel réseau. no-store appliqué globalement aux /api par hooks.server.ts.
 * Consommé par le store health (bandeau d'alerte global).
 */
export const GET: RequestHandler = async () => {
  return json({ mqtt: isMqttConnected(), ts: Date.now() });
};
