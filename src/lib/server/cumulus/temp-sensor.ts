/**
 * Lecture serveur des sondes de température Zigbee (cache MQTT multi-topic).
 *
 * Souscription MQTT PERMANENTE (retained → la dernière valeur arrive dès la
 * souscription) avec un cache `{ tempC, receivedAt }` par topic. Le moteur lit
 * ce cache à chaque tick et juge la fraîcheur via l'âge de réception.
 *
 *   - `thermo_cumulus` : sonde eau (point bas du ballon) — ÉTAPE 1.
 *   - sonde intérieure (T_room, ex. `Thermo SdB`) — ÉTAPE 1b, topic configurable.
 *
 * Réutilise le client MQTT singleton de mqtt.ts (même connexion que le portail).
 */

import { getMqttClient } from '../mqtt';

const CUMULUS_TOPIC = 'zigbee2mqtt/thermo_cumulus';

interface Reading {
  tempC: number | null;
  receivedAt: number | null;
}

const cache = new Map<string, Reading>();
const subscribed = new Set<string>();
let wired = false;

/** Branche une seule fois le routage des messages + la re-souscription à la reconnexion. */
function wire(): void {
  if (wired) return;
  wired = true;
  const c = getMqttClient();

  c.on('message', (topic, payload) => {
    if (!subscribed.has(topic)) return;
    try {
      const d = JSON.parse(payload.toString()) as { temperature?: unknown };
      if (typeof d.temperature === 'number' && Number.isFinite(d.temperature)) {
        cache.set(topic, { tempC: d.temperature, receivedAt: Date.now() });
      }
    } catch {
      // payload non-JSON / partiel → ignoré
    }
  });

  // Re-souscrire TOUS les topics après chaque (re)connexion.
  c.on('connect', () => {
    for (const t of subscribed) {
      c.subscribe(t, (err) => {
        if (err) console.error('[cumulus] re-souscription', t, 'échouée:', err.message);
      });
    }
  });
}

/** Souscrit (idempotent) un topic de température et garantit le routage. */
function subscribeTopic(topic: string): void {
  wire();
  if (!subscribed.has(topic)) {
    subscribed.add(topic);
    if (!cache.has(topic)) cache.set(topic, { tempC: null, receivedAt: null });
  }
  const c = getMqttClient();
  if (c.connected) {
    c.subscribe(topic, (err) => {
      if (err) console.error('[cumulus] souscription', topic, 'échouée:', err.message);
    });
  }
  // sinon : le handler 'connect' de wire() s'en chargera à la connexion
}

function read(topic: string): { tempC: number | null; ageMs: number | null } {
  const r = cache.get(topic);
  if (!r) return { tempC: null, ageMs: null };
  return { tempC: r.tempC, ageMs: r.receivedAt === null ? null : Date.now() - r.receivedAt };
}

/** Démarre la souscription de la sonde eau (idempotent) — à appeler tôt. */
export function ensureTempSensor(): void {
  subscribeTopic(CUMULUS_TOPIC);
}

/** Dernière température eau reçue + âge (ms). `tempC` null si jamais reçue. */
export function getCumulusTemp(): { tempC: number | null; ageMs: number | null } {
  subscribeTopic(CUMULUS_TOPIC);
  return read(CUMULUS_TOPIC);
}

/** Démarre la souscription d'un topic de température arbitraire — idempotent. */
export function ensureTempTopic(topic: string): void {
  if (topic) subscribeTopic(topic);
}

/** Dernière température reçue + âge (ms) pour un topic arbitraire. */
export function getTempTopic(topic: string): { tempC: number | null; ageMs: number | null } {
  if (!topic) return { tempC: null, ageMs: null };
  subscribeTopic(topic);
  return read(topic);
}
