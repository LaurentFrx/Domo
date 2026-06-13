/**
 * Lecture serveur de la sonde température eau (Zigbee `thermo_cumulus`).
 *
 * Souscription MQTT PERMANENTE au topic `zigbee2mqtt/thermo_cumulus` (retained →
 * la dernière valeur arrive dès la souscription), avec un cache `{ tempC,
 * receivedAt }`. Le moteur lit ce cache à chaque tick et juge la fraîcheur via
 * l'âge de réception (pas de readRetained one-shot, fragile).
 *
 * Réutilise le client MQTT singleton de mqtt.ts (même connexion que le portail).
 */

import { getMqttClient } from '../mqtt';

const TOPIC = 'zigbee2mqtt/thermo_cumulus';

let started = false;
let tempC: number | null = null;
let receivedAt: number | null = null;

function start(): void {
  if (started) return;
  started = true;
  const c = getMqttClient();

  const subscribe = () => {
    c.subscribe(TOPIC, (err) => {
      if (err) console.error('[cumulus] souscription thermo_cumulus échouée:', err.message);
    });
  };

  if (c.connected) subscribe();
  c.on('connect', subscribe); // re-souscription après chaque (re)connexion

  c.on('message', (topic, payload) => {
    if (topic !== TOPIC) return;
    try {
      const d = JSON.parse(payload.toString()) as { temperature?: unknown };
      if (typeof d.temperature === 'number' && Number.isFinite(d.temperature)) {
        tempC = d.temperature;
        receivedAt = Date.now();
      }
    } catch {
      // payload non-JSON / partiel → ignoré
    }
  });
}

/** Démarre la souscription (idempotent) — à appeler tôt dans le cycle de vie. */
export function ensureTempSensor(): void {
  start();
}

/** Dernière température reçue + âge (ms). `tempC` null si jamais reçue. */
export function getCumulusTemp(): { tempC: number | null; ageMs: number | null } {
  start();
  return { tempC, ageMs: receivedAt === null ? null : Date.now() - receivedAt };
}
