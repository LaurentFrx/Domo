/**
 * Client MQTT serveur — singleton persistant (un seul par process node).
 *
 * Sert à publier des commandes Zigbee2MQTT depuis le backend (ex. ouverture du
 * portail via /api/portail/pulse), sans dépendre d'un navigateur connecté à
 * /pieces. Le client est créé paresseusement à la première commande puis
 * réutilisé entre requêtes (reconnexion auto) — jamais une connexion par requête.
 *
 * Connexion : on vise le listener WebSocket LOCAL de mosquitto
 * (ws://127.0.0.1:9001, tunnelisé depuis le RPi4) plutôt que le détour public
 * wss://domo.feroux.fr/mqtt/. URL surchargeable via MQTT_INTERNAL_URL (privé).
 * Identifiants : mêmes que le navigateur (PUBLIC_MQTT_USER / PUBLIC_MQTT_PASSWORD).
 *
 * Additif : ne touche pas au chemin navigateur (src/lib/stores/zigbee.svelte.ts).
 */

import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

const INTERNAL_URL = privateEnv.MQTT_INTERNAL_URL || 'ws://127.0.0.1:9001';
const MQTT_USER = publicEnv.PUBLIC_MQTT_USER || '';
const MQTT_PASSWORD = publicEnv.PUBLIC_MQTT_PASSWORD || '';

const PORTAIL_TOPIC = 'zigbee2mqtt/Portail/set';
const CONNECT_TIMEOUT_MS = 5000; // attente max d'une connexion établie
const PULSE_GAP_MS = 500; // délai ON → OFF (identique au bouton /pieces)
const PULSE_LOCK_MS = 2000; // fenêtre anti-double-déclenchement (géofence/retries)

let client: MqttClient | null = null;
let pulsing = false;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Crée (une fois) ou réutilise le client singleton. */
function getClient(): MqttClient {
  if (client) return client;
  client = mqtt.connect(INTERNAL_URL, {
    username: MQTT_USER,
    password: MQTT_PASSWORD,
    protocolVersion: 4, // MQTT 3.1.1, comme le client navigateur
    reconnectPeriod: 5000,
    connectTimeout: 8000,
    clientId: `domo-server-${process.pid}`
  });
  // On loggue sans throw : la reconnexion auto reprend la main, et pulsePortail()
  // applique son propre timeout d'attente de connexion.
  client.on('error', (err) => console.error('[mqtt] erreur client:', err.message));
  return client;
}

/**
 * Expose le client singleton pour les souscriptions serveur (ex. lecture
 * permanente de la sonde température cumulus). Réutilise la MÊME connexion que
 * pulsePortail() — un seul client MQTT par process.
 */
export function getMqttClient(): MqttClient {
  return getClient();
}

/** Résout quand le client est connecté, rejette au-delà de `timeoutMs`. */
function waitConnected(c: MqttClient, timeoutMs: number): Promise<void> {
  if (c.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MQTT non connecté après ${timeoutMs}ms (${INTERNAL_URL})`));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      clearTimeout(timer);
      c.removeListener('connect', onConnect);
      c.removeListener('error', onError);
    }
    c.once('connect', onConnect);
    c.once('error', onError);
  });
}

/** publish() promisifié en QoS 1 (livraison au moins une fois). */
function publishQos1(c: MqttClient, topic: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.publish(topic, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
}

export type PulseResult = 'ok' | 'already_pulsing';

/**
 * Reproduit l'« Impulsion » du portail côté serveur :
 *   publish zigbee2mqtt/Portail/set {"state":"ON"} → 500ms → {"state":"OFF"}.
 * QoS 1 (plus fiable que le QoS 0 navigateur pour une commande de portail).
 *
 * Verrou : si un pulse est déjà en cours (fenêtre ~2s), renvoie 'already_pulsing'
 * sans réémettre. Lève une erreur si MQTT ne se connecte pas dans les temps.
 */
export async function pulsePortail(): Promise<PulseResult> {
  if (pulsing) return 'already_pulsing';
  pulsing = true;
  // Le verrou tient PULSE_LOCK_MS au total (couvre la séquence ~500ms + une marge
  // anti-retry), puis se relâche tout seul — pas de reset dans un finally qui
  // raccourcirait la fenêtre en cas de succès.
  setTimeout(() => {
    pulsing = false;
  }, PULSE_LOCK_MS);

  const c = getClient();
  await waitConnected(c, CONNECT_TIMEOUT_MS);
  await publishQos1(c, PORTAIL_TOPIC, JSON.stringify({ state: 'ON' }));
  await delay(PULSE_GAP_MS);
  await publishQos1(c, PORTAIL_TOPIC, JSON.stringify({ state: 'OFF' }));
  return 'ok';
}
