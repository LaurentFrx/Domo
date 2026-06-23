/**
 * Zigbee store — état temps réel via SSE serveur (/api/zigbee/stream), commandes
 * via /api/zigbee/set. AUCUN identifiant MQTT côté navigateur (R14) : le serveur
 * (ha_user) est le seul à parler à mosquitto ; le client ne voit qu'un flux
 * authentifié. Le format `{topic, payload}` reproduit le flux MQTT d'origine, donc
 * la logique de dispatch par topic est inchangée.
 *
 * Découverte : `zigbee2mqtt/bridge/devices` (snapshot complet à la connexion).
 * États : `zigbee2mqtt/<friendly_name>` (un topic par device).
 * Commandes : POST /api/zigbee/set (allow-list appliquée côté serveur).
 */

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
  // « Chargeur Laurent » a été rebranché sur le frigo et renommé « Frigo » (z2m) ;
  // l'ancienne prise « Frigo » (vide) est devenue « Prise libre ».
  'Prise libre': 'Cuisine',
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
// que le flux n'ait fini de (re)connecter (évite le « toggle qui flashe OFF »
// pendant 1-2s au reload). Écrasé dès qu'un payload retained arrive.
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
  private es: EventSource | null = null;

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

  /** Devices d'une pièce — pratique pour regrouper l'affichage par pièce. */
  byRoom(room: string): ZigbeeDevice[] {
    return this.devices.filter((d) => d.room === room);
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.es) return;

    this.connectionStatus = 'connecting';
    const es = new EventSource('/api/zigbee/stream');
    this.es = es;

    es.onopen = () => {
      this.connectionStatus = 'connected';
      this.lastError = null;
    };

    es.addEventListener('zigbee', (ev) => {
      try {
        const { topic, payload } = JSON.parse((ev as MessageEvent).data) as {
          topic: string;
          payload: string;
        };
        if (topic === 'zigbee2mqtt/bridge/devices') {
          this.handleDeviceList(JSON.parse(payload) as BridgeDevice[]);
        } else if (topic.startsWith('zigbee2mqtt/') && !topic.includes('/bridge/')) {
          const friendly = topic.slice('zigbee2mqtt/'.length);
          if (friendly && !friendly.includes('/')) this.handleDeviceState(friendly, payload);
        }
      } catch (e) {
        this.lastError = `parse: ${(e as Error).message}`;
      }
      this.lastUpdate = new Date();
    });

    es.onerror = () => {
      // EventSource se reconnecte tout seul ; on reflète juste l'état.
      this.connectionStatus = 'disconnected';
    };
  }

  disconnect() {
    this.es?.close();
    this.es = null;
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

  // ─── Commandes (via endpoint serveur authentifié, allow-list serveur) ───
  private async publishSet(
    friendlyName: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const r = await fetch('/api/zigbee/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-domo-app': '1' },
        body: JSON.stringify({ device: friendlyName, payload })
      });
      if (!r.ok) {
        this.lastError = `commande refusée (HTTP ${r.status})`;
        return false;
      }
      const d = (await r.json().catch(() => ({ ok: false }))) as { ok?: boolean };
      if (!d.ok) {
        this.lastError = 'commande non transmise (hors ligne)';
        return false;
      }
      this.lastError = null;
      return true;
    } catch {
      this.lastError = 'commande non envoyée';
      return false;
    }
  }

  setState(friendlyName: string, state: 'ON' | 'OFF' | 'TOGGLE') {
    void this.publishSet(friendlyName, { state });
  }

  toggle(friendlyName: string) {
    const dev = this.devices.find((d) => d.friendlyName === friendlyName);
    if (!dev) return;
    const cur = dev.state.state as string | undefined;
    void this.publishSet(friendlyName, { state: cur === 'ON' ? 'OFF' : 'ON' });
  }

  setBrightness(friendlyName: string, brightness: number) {
    void this.publishSet(friendlyName, { brightness: Math.max(0, Math.min(254, brightness)) });
  }

  /** Portail NodOn : impulse (pulse on/off court). Note : le Portail n'est PAS dans
   *  l'allow-list serveur (passe par /api/portail/pulse) — conservé par cohérence. */
  pulse(friendlyName: string) {
    void this.publishSet(friendlyName, { state: 'ON' });
    setTimeout(() => void this.publishSet(friendlyName, { state: 'OFF' }), 500);
  }
}

export const zigbee = new ZigbeeState();
