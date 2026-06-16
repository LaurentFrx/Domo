/**
 * Abonnement serveur unique à findmy/# (via getMqttClient → ws://127.0.0.1:9001
 * interne), cache des derniers payloads (livre l'état « retained » à chaque
 * nouveau client SSE), diffusion des updates. Aucune credential ne sort vers le
 * navigateur — la carte consomme /api/findmy/stream (SSE) derrière l'auth.
 */
import { getMqttClient } from './mqtt';

type Listener = (topic: string, payload: string) => void;
const cache = new Map<string, string>();
const listeners = new Set<Listener>();
let started = false;

function start() {
  if (started) return;
  started = true;
  const client = getMqttClient();
  client.subscribe('findmy/#', { qos: 0 }, (err) => {
    if (err) console.error('[findmy] subscribe error', err);
  });
  // mqtt.js émet "message" pour TOUS les topics du singleton -> on filtre findmy/.
  client.on('message', (topic: string, buf: Buffer) => {
    if (!topic.startsWith('findmy/')) return;
    const payload = buf.toString();
    cache.set(topic, payload);
    for (const l of listeners) {
      try {
        l(topic, payload);
      } catch (e) {
        console.error('[findmy] listener', e);
      }
    }
  });
}

export function findmySnapshot(): Array<{ topic: string; payload: string }> {
  start();
  return [...cache.entries()].map(([topic, payload]) => ({ topic, payload }));
}

export function findmySubscribe(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
