/**
 * Hub Zigbee serveur — abonnement UNIQUE à zigbee2mqtt/ via le client MQTT serveur
 * (ha_user, ws://127.0.0.1:9001 interne), cache des derniers payloads (livre l'état
 * « retained » à chaque nouveau client SSE), diffusion des updates.
 *
 * But (R14) : AUCUN identifiant MQTT ne sort vers le navigateur. Le store
 * `zigbee.svelte.ts` consomme /api/zigbee/stream (SSE, derrière l'auth) et écrit via
 * /api/zigbee/set. Modèle : findmy.ts (même découplage déjà éprouvé pour la position
 * famille).
 *
 * Écriture RESTREINTE (allow-list) : on réplique exactement l'ancienne ACL du compte
 * domo_web (lumiere_atelier + Imprimante Epson). Le Portail passe par son endpoint
 * dédié /api/portail/pulse — jamais d'ouverture du portail par ce chemin.
 */
import { getMqttClient } from './mqtt';

type Listener = (topic: string, payload: string) => void;
const cache = new Map<string, string>();
const listeners = new Set<Listener>();
let started = false;

const WRITABLE = new Set(['lumiere_atelier', 'Imprimante Epson']);

function start() {
  if (started) return;
  started = true;
  const client = getMqttClient();
  const sub = () => {
    client.subscribe('zigbee2mqtt/bridge/devices', { qos: 0 });
    client.subscribe('zigbee2mqtt/+', { qos: 0 }); // états par device (1 niveau)
  };
  if (client.connected) sub();
  client.on('connect', sub); // re-souscrit après une reconnexion
  client.on('message', (topic: string, buf: Buffer) => {
    if (!topic.startsWith('zigbee2mqtt/')) return;
    // On ne garde QUE la liste des devices et les états par device (1 niveau) —
    // pas les autres topics bridge/* (logs, infos…).
    if (topic !== 'zigbee2mqtt/bridge/devices') {
      const friendly = topic.slice('zigbee2mqtt/'.length);
      if (friendly.includes('/')) return; // /set, /availability, bridge/* … ignorés
    }
    const payload = buf.toString();
    cache.set(topic, payload);
    for (const l of listeners) {
      try {
        l(topic, payload);
      } catch (e) {
        console.error('[zigbee-hub] listener', e);
      }
    }
  });
}

export function zigbeeSnapshot(): Array<{ topic: string; payload: string }> {
  start();
  return [...cache.entries()].map(([topic, payload]) => ({ topic, payload }));
}

export function zigbeeSubscribe(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publie une commande /set — UNIQUEMENT pour les devices en liste blanche. */
export function zigbeePublishSet(friendly: string, payload: Record<string, unknown>): boolean {
  if (!WRITABLE.has(friendly)) return false;
  const client = getMqttClient();
  if (!client.connected) return false;
  client.publish(`zigbee2mqtt/${friendly}/set`, JSON.stringify(payload), { qos: 0 });
  return true;
}
