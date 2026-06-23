import { json } from '@sveltejs/kit';
import { isMqttConnected } from '$lib/server/mqtt';
import { activeIncidents } from '$lib/server/monitor/incidents';
import type { RequestHandler } from './$types';

/**
 * Santé de la liaison domotique vue du serveur Domo.
 *
 * `mqtt`      = hub MQTT joignable (capteurs Zigbee, sonde cumulus, portail) —
 *               historique : proxy de « plus aucune connexion », pilote le bandeau.
 * `incidents` = anomalies ACTIVES détectées par le moniteur (recorder figé, APS
 *               aveugle, EM-50/Anker muets, fichier corrompu…). Surfacées dans le
 *               bandeau et la page Réglages.
 *
 * Lecture 100 % en mémoire (état MQTT + bus d'incidents) → réponse instantanée,
 * aucun appel réseau. no-store appliqué globalement aux /api par hooks.server.ts.
 */
export const GET: RequestHandler = async () => {
  return json({ mqtt: isMqttConnected(), incidents: activeIncidents(), ts: Date.now() });
};
