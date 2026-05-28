/**
 * Zigbee store — connexion MQTT WebSocket (mosquitto:9001) au broker
 * du RPi4, proxié en WSS via Caddy (/mqtt/).
 *
 * Découverte : abonnement à `zigbee2mqtt/bridge/devices` (retained →
 * snapshot complet à la connexion). États : abonnement à
 * `zigbee2mqtt/<friendly_name>` (un topic par device, retained).
 * Commandes : publish sur `zigbee2mqtt/<friendly_name>/set` payload JSON.
 */

import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { env } from '$env/dynamic/public';

const PUBLIC_MQTT_WS_URL = env.PUBLIC_MQTT_WS_URL || '';
const PUBLIC_MQTT_USER = env.PUBLIC_MQTT_USER || '';
const PUBLIC_MQTT_PASSWORD = env.PUBLIC_MQTT_PASSWORD || '';

export type ZigbeeCategory = 'sensor' | 'plug' | 'light' | 'cover' | 'switch' | 'unknown';

export type ZigbeeDevice = {
  ieee: string;
  friendlyName: string;
  vendor: string;
  model: string;
  description: string;
  category: ZigbeeCategory;
  room: string;
  /** false = device perdu pour Z2M */
  available: boolean;
  /** Dernier payload state reçu */
  state: Record<string, unknown>;
};

// ─── Mapping friendly_name → pièce (basé sur l'inventaire 2026-05-27) ──
const ZIGBEE_ROOMS: Record<string, string> = {
  Frigo: 'Cuisine',
  'Lave-linge': 'Cuisine',
  Lave_vaisselle: 'Cuisine',
  'ordi moniteur': 'Bureau',
  'Imprimante Epson': 'Bureau',
  'Thermo SdB': 'Salle de bain',
  'Thermo Salon': 'Séjour',
  'Chargeur Isa': 'Séjour',
  'Chargeur Laurent': 'Séjour',
  'Thermo Garage': 'Garage',
  thermo_cumulus: 'Garage',
  Thermo_ext: 'Extérieur',
  Thermo_velos: 'Extérieur',
  Portail: 'Extérieur',
  lumiere_atelier: 'Atelier'
};

// ─── Inférence catégorie depuis le model_id Z2M ─────────────────────────
function inferCategory(model: string, description: string): ZigbeeCategory {
  const m = (model || '').toUpperCase();
  const d = (description || '').toLowerCase();
  if (m.startsWith('SNZB-02')) return 'sensor';
  if (m === 'TS011F') return 'plug';
  if (m === 'SIN-4-1-21' || d.includes('portail') || d.includes('cover')) return 'cover';
  if (m === 'ZBMINIL2' || d.includes('switch')) return 'switch';
  if (d.includes('light') || d.includes('bulb') || d.includes('lampe')) return 'light';
  return 'unknown';
}

type BridgeDevice = {
  ieee_address?: string;
  friendly_name?: string;
  type?: string;
  manufacturer?: string;
  model_id?: string;
  description?: string;
  definition?: { description?: string } | null;
};

// ─── Cache localStorage : restaure les derniers états connus avant
// que MQTT n'ait fini de reconnecter (évite le « toggle qui flashe OFF »
// pendant 1-2s au reload). Le cache est écrasé dès qu'un payload MQTT
// retained arrive.
const CACHE_KEY = 'domo.zigbee.cache.v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function loadCachedDevices(): ZigbeeDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { ts: number; devices: ZigbeeDevice[] };
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) return [];
    return parsed.devices ?? [];
  } catch {
    return [];
  }
}

function saveCachedDevices(devices: ZigbeeDevice[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), devices }));
  } catch {
    // localStorage indisponible (mode privé, quota…) : on accepte la perte.
  }
}

class ZigbeeState {
  devices = $state<ZigbeeDevice[]>(loadCachedDevices());
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected' | 'unconfigured'>(
    'disconnected'
  );
  lastUpdate = $state<Date | null>(null);
  lastError = $state<string | null>(null);
  private client: MqttClient | null = null;

  /** Devices regroupés par pièce. Utilisé par /pieces. */
  rooms = $derived.by<{ room: string; devices: ZigbeeDevice[] }[]>(() => {
    const grouped = new Map<string, ZigbeeDevice[]>();
    for (const d of this.devices) {
      const list = grouped.get(d.room) || [];
      list.push(d);
      grouped.set(d.room, list);
    }
    return [...grouped.entries()]
      .map(([room, devices]) => ({ room, devices }))
      .sort((a, b) => b.devices.length - a.devices.length || a.room.localeCompare(b.room, 'fr'));
  });

  /** Devices par catégorie pour une pièce. Pratique pour les RoomSection. */
  byRoom(room: string): ZigbeeDevice[] {
    return this.devices.filter((d) => d.room === room);
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.client) return;

    if (!PUBLIC_MQTT_WS_URL || !PUBLIC_MQTT_USER || !PUBLIC_MQTT_PASSWORD) {
      this.connectionStatus = 'unconfigured';
      this.lastError = 'MQTT credentials manquants (PUBLIC_MQTT_*)';
      return;
    }

    this.connectionStatus = 'connecting';
    this.client = mqtt.connect(PUBLIC_MQTT_WS_URL, {
      username: PUBLIC_MQTT_USER,
      password: PUBLIC_MQTT_PASSWORD,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      clientId: `domo-pwa-${Math.random().toString(36).slice(2, 10)}`
    });

    this.client.on('connect', () => {
      this.connectionStatus = 'connected';
      this.lastError = null;
      this.client?.subscribe('zigbee2mqtt/bridge/devices', { qos: 0 });
      this.client?.subscribe('zigbee2mqtt/+', { qos: 0 });
    });

    this.client.on('reconnect', () => {
      this.connectionStatus = 'connecting';
    });

    this.client.on('close', () => {
      if (this.connectionStatus !== 'unconfigured') {
        this.connectionStatus = 'disconnected';
      }
    });

    this.client.on('error', (err) => {
      this.lastError = err.message;
    });

    this.client.on('message', (topic, payload) => {
      try {
        const txt = payload.toString();
        if (topic === 'zigbee2mqtt/bridge/devices') {
          this.handleDeviceList(JSON.parse(txt) as BridgeDevice[]);
        } else if (topic.startsWith('zigbee2mqtt/') && !topic.includes('/bridge/')) {
          const friendly = topic.slice('zigbee2mqtt/'.length);
          if (friendly && !friendly.includes('/')) {
            this.handleDeviceState(friendly, txt);
          }
        }
      } catch (e) {
        this.lastError = `parse: ${(e as Error).message}`;
      }
      this.lastUpdate = new Date();
    });
  }

  disconnect() {
    this.client?.end();
    this.client = null;
    this.connectionStatus = 'disconnected';
  }

  private handleDeviceList(list: BridgeDevice[]) {
    const next: ZigbeeDevice[] = [];
    for (const d of list) {
      if (d.type === 'Coordinator') continue;
      const friendly = d.friendly_name || d.ieee_address || '?';
      const model = d.model_id || '';
      const desc = d.description || d.definition?.description || '';
      const existing = this.devices.find((x) => x.friendlyName === friendly);
      next.push({
        ieee: d.ieee_address || friendly,
        friendlyName: friendly,
        vendor: d.manufacturer || '?',
        model,
        description: desc,
        category: inferCategory(model, desc),
        room: ZIGBEE_ROOMS[friendly] || 'Autre',
        available: existing?.available ?? true,
        state: existing?.state ?? {}
      });
    }
    next.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, 'fr'));
    this.devices = next;
    saveCachedDevices(next);
  }

  private handleDeviceState(friendlyName: string, rawPayload: string) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch {
      return;
    }
    const idx = this.devices.findIndex((d) => d.friendlyName === friendlyName);
    if (idx < 0) return;
    this.devices[idx] = {
      ...this.devices[idx],
      state: { ...this.devices[idx].state, ...parsed },
      available: parsed.available !== false
    };
    saveCachedDevices(this.devices);
  }

  // ─── Commandes ───
  private publishSet(friendlyName: string, payload: Record<string, unknown>) {
    if (!this.client || this.connectionStatus !== 'connected') return;
    this.client.publish(`zigbee2mqtt/${friendlyName}/set`, JSON.stringify(payload), { qos: 0 });
  }

  setState(friendlyName: string, state: 'ON' | 'OFF' | 'TOGGLE') {
    this.publishSet(friendlyName, { state });
  }

  toggle(friendlyName: string) {
    const dev = this.devices.find((d) => d.friendlyName === friendlyName);
    if (!dev) return;
    const cur = dev.state.state as string | undefined;
    this.publishSet(friendlyName, { state: cur === 'ON' ? 'OFF' : 'ON' });
  }

  setBrightness(friendlyName: string, brightness: number) {
    this.publishSet(friendlyName, { brightness: Math.max(0, Math.min(254, brightness)) });
  }

  /** Portail NodOn : impulse (pulse on/off court). */
  pulse(friendlyName: string) {
    this.publishSet(friendlyName, { state: 'ON' });
    setTimeout(() => this.publishSet(friendlyName, { state: 'OFF' }), 500);
  }
}

export const zigbee = new ZigbeeState();
