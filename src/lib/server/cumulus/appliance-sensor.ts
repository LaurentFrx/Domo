/**
 * Lecture serveur des prises électroménager Zigbee (cache MQTT multi-topic).
 *
 * Même principe que temp-sensor.ts : souscription MQTT PERMANENTE (retained → la
 * dernière valeur arrive dès la souscription), cache { powerW, energyKwh, receivedAt }
 * par topic. Le moteur lit ce cache à chaque tick pour détecter les CYCLES des gros
 * consommateurs (lave-vaisselle, lave-linge) → nommer la conso dans le journal +
 * expliquer l'effet sur le pilotage du chauffe-eau (délestage 6 kVA).
 *
 * Prises TS011F (Tuya) : payload JSON `{ power (W instantané), energy (kWh cumulée,
 * monotone), state, current, voltage }`. Certains messages sont PARTIELS (state seul)
 * → on FUSIONNE avec la dernière valeur connue. OBSERVATION : ne pilote rien.
 *
 * Réutilise le client MQTT singleton de mqtt.ts (même connexion que le portail).
 */

import { getMqttClient } from '../mqtt';

/**
 * Gros consommateurs suivis (prises Zigbee TS011F). Le frigo est EXCLU (conso
 * permanente de fond, pas un cycle ponctuel). L'induction / le four / la bouilloire
 * ne sont PAS sur prise mesurée → invisibles individuellement (ils comptent seulement
 * dans la conso maison globale, donc dans le délestage 6 kVA).
 */
export const TRACKED_APPLIANCES: { name: string; topic: string; onW: number }[] = [
  { name: 'Lave-vaisselle', topic: 'zigbee2mqtt/Lave_vaisselle', onW: 100 },
  { name: 'Lave-linge', topic: 'zigbee2mqtt/Lave-linge', onW: 100 }
];

interface Reading {
  powerW: number | null;
  energyKwh: number | null;
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
      const d = JSON.parse(payload.toString()) as { power?: unknown; energy?: unknown };
      const prev = cache.get(topic);
      // Messages partiels : on garde la dernière valeur connue de chaque champ.
      const powerW =
        typeof d.power === 'number' && Number.isFinite(d.power) ? d.power : (prev?.powerW ?? null);
      const energyKwh =
        typeof d.energy === 'number' && Number.isFinite(d.energy)
          ? d.energy
          : (prev?.energyKwh ?? null);
      cache.set(topic, { powerW, energyKwh, receivedAt: Date.now() });
    } catch {
      // payload non-JSON / partiel → ignoré
    }
  });

  // Re-souscrire TOUS les topics après chaque (re)connexion.
  c.on('connect', () => {
    for (const t of subscribed) {
      c.subscribe(t, (err) => {
        if (err) console.error('[cumulus] re-souscription prise', t, 'échouée:', err.message);
      });
    }
  });
}

/** Souscrit (idempotent) un topic de prise et garantit le routage. */
function subscribeTopic(topic: string): void {
  wire();
  if (!subscribed.has(topic)) {
    subscribed.add(topic);
    if (!cache.has(topic)) cache.set(topic, { powerW: null, energyKwh: null, receivedAt: null });
  }
  const c = getMqttClient();
  if (c.connected) {
    c.subscribe(topic, (err) => {
      if (err) console.error('[cumulus] souscription prise', topic, 'échouée:', err.message);
    });
  }
  // sinon : le handler 'connect' de wire() s'en chargera à la connexion
}

/** Démarre la souscription de toutes les prises suivies (idempotent) — à appeler tôt. */
export function ensureApplianceSensors(): void {
  for (const a of TRACKED_APPLIANCES) subscribeTopic(a.topic);
}

/** Dernière mesure d'une prise + âge (ms). `powerW` null si jamais reçue. */
export function getAppliancePower(topic: string): {
  powerW: number | null;
  energyKwh: number | null;
  ageMs: number | null;
} {
  subscribeTopic(topic);
  const r = cache.get(topic);
  if (!r) return { powerW: null, energyKwh: null, ageMs: null };
  return {
    powerW: r.powerW,
    energyKwh: r.energyKwh,
    ageMs: r.receivedAt === null ? null : Date.now() - r.receivedAt
  };
}
