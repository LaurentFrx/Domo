/**
 * FindMy store — appareils Apple « Localiser » (iCloud Find My).
 *
 * Source : flux SSE `/api/findmy/stream` (proxy serveur, derrière l'auth magic-link).
 * Le serveur lit `findmy/#` sur le broker interne et rediffuse `{ topic, payload }` ;
 * AUCUNE credential MQTT n'est exposée au navigateur (≠ ancien client WSS direct).
 * À chaque (re)connexion le serveur renvoie un snapshot (= remplace le retained MQTT),
 * puis les mises à jour live.
 *   - `findmy/_status`      → { state: 'starting'|'ok'|'reauth_required'|'offline', ts }
 *   - `findmy/<topic-id>`   → un appareil, payload { id, name, class, battery, …, lat, lon, … }
 *
 * Lecture seule (aucune commande) : on ne fait qu'observer.
 */

const TOPIC_PREFIX = 'findmy/';
const STATUS_TOPIC = 'findmy/_status';

export type FindMyStatus = 'unknown' | 'starting' | 'ok' | 'reauth_required' | 'offline';

export type FindMyDevice = {
  /** Clé unique = segment de topic (ex. `iphone-laurent-ayxs2tda`). */
  topicId: string;
  /** Identifiant Apple brut (peut être null). */
  id: string | null;
  name: string;
  /** iPhone | iPad | Watch | Accessory | Mac … (peut être null). */
  deviceClass: string | null;
  /** 0-100, ou null si inconnu. */
  battery: number | null;
  batteryStatus: string | null;
  charging: boolean;
  lat: number | null;
  lon: number | null;
  /** Précision horizontale en mètres. */
  accuracy: number | null;
  /** Epoch (s) du point GPS. */
  fixTs: number | null;
  /** Epoch (s) de la dernière publication du bridge pour cet appareil. */
  ts: number | null;
};

type RawDevicePayload = {
  id?: string | null;
  name?: string | null;
  class?: string | null;
  battery?: number | null;
  battery_status?: string | null;
  charging?: boolean;
  ts?: number | null;
  lat?: number | null;
  lon?: number | null;
  accuracy?: number | null;
  fix_ts?: number | null;
};

function num(v: unknown): number | null {
  return Number.isFinite(v) ? (v as number) : null;
}

function parseDevice(topicId: string, raw: RawDevicePayload): FindMyDevice {
  return {
    topicId,
    id: typeof raw.id === 'string' ? raw.id : null,
    name: (typeof raw.name === 'string' && raw.name) || topicId,
    deviceClass: typeof raw.class === 'string' ? raw.class : null,
    battery: num(raw.battery),
    batteryStatus: typeof raw.battery_status === 'string' ? raw.battery_status : null,
    charging: raw.charging === true,
    lat: num(raw.lat),
    lon: num(raw.lon),
    accuracy: num(raw.accuracy),
    fixTs: num(raw.fix_ts),
    ts: num(raw.ts)
  };
}

// ─── Cache localStorage : réaffiche le dernier état connu pendant que MQTT
// reconnecte (évite une carte vide 1-2 s au reload). Écrasé dès qu'un payload
// retained arrive. Même pattern que zigbee.svelte.ts.
const CACHE_KEY = 'domo.findmy.cache.v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function loadCached(): FindMyDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { ts: number; devices: FindMyDevice[] };
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) return [];
    return parsed.devices ?? [];
  } catch {
    return [];
  }
}

function saveCached(devices: FindMyDevice[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), devices }));
  } catch {
    // localStorage indisponible (mode privé, quota) : perte acceptée.
  }
}

// Priorité d'affichage par type d'appareil (les plus « utiles » en premier).
function classOrder(c: string | null): number {
  const s = (c || '').toLowerCase();
  if (s.includes('iphone')) return 0;
  if (s.includes('ipad')) return 1;
  if (s.includes('watch')) return 2;
  if (s.includes('mac')) return 3;
  if (s.includes('accessory') || s.includes('airpod')) return 4;
  return 5;
}

class FindMyState {
  devices = $state<FindMyDevice[]>(loadCached());
  /** État du daemon (topic `_status`). */
  status = $state<FindMyStatus>('unknown');
  statusTs = $state<number | null>(null);
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected' | 'unconfigured'>(
    'disconnected'
  );
  lastUpdate = $state<Date | null>(null);
  lastError = $state<string | null>(null);
  private es: EventSource | null = null;
  private visibilityHandler: (() => void) | null = null;

  /** Appareils triés : localisés d'abord, puis par type, puis par nom. */
  sorted = $derived.by<FindMyDevice[]>(() =>
    [...this.devices].sort((a, b) => {
      const la = a.lat != null ? 0 : 1;
      const lb = b.lat != null ? 0 : 1;
      if (la !== lb) return la - lb;
      const ca = classOrder(a.deviceClass);
      const cb = classOrder(b.deviceClass);
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name, 'fr');
    })
  );

  count = $derived(this.devices.length);

  connect() {
    if (typeof window === 'undefined') return;
    if (this.es) return;

    this.openStream();

    // Reconnexion au retour au premier plan : en mobilité l'EventSource peut être
    // gelé/tué en arrière-plan → on recrée le flux, ce qui force le serveur à
    // renvoyer un snapshot frais (au lieu de rester figé sur le cache).
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.openStream();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /** (Re)ouvre le flux SSE. Chaque nouvelle connexion = snapshot serveur frais. */
  private openStream() {
    if (typeof window === 'undefined') return;
    this.es?.close();
    this.connectionStatus = 'connecting';

    const es = new EventSource('/api/findmy/stream');
    this.es = es;

    es.onopen = () => {
      this.connectionStatus = 'connected';
      this.lastError = null;
    };

    es.addEventListener('findmy', (e) => {
      this.connectionStatus = 'connected';
      try {
        const { topic, payload } = JSON.parse((e as MessageEvent).data) as {
          topic: string;
          payload: string;
        };
        if (topic === STATUS_TOPIC) {
          this.handleStatus(payload);
        } else if (topic.startsWith(TOPIC_PREFIX)) {
          const topicId = topic.slice(TOPIC_PREFIX.length);
          if (topicId && !topicId.startsWith('_')) this.handleDevice(topicId, payload);
        }
      } catch (err) {
        this.lastError = `parse: ${(err as Error).message}`;
      }
      this.lastUpdate = new Date();
    });

    es.onerror = () => {
      // EventSource retente seul ; on signale « hors ligne » (badge), et un retour
      // au premier plan (visibilitychange) force un flux neuf + snapshot.
      this.connectionStatus = 'disconnected';
    };
  }

  disconnect() {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.es?.close();
    this.es = null;
    this.connectionStatus = 'disconnected';
  }

  private handleStatus(rawPayload: string) {
    if (!rawPayload.trim()) return;
    const parsed = JSON.parse(rawPayload) as { state?: string; ts?: number };
    const s = parsed.state;
    if (s === 'ok' || s === 'starting' || s === 'reauth_required' || s === 'offline') {
      this.status = s;
    }
    this.statusTs = num(parsed.ts);
  }

  private handleDevice(topicId: string, rawPayload: string) {
    // Payload vide = topic retained purgé → on retire l'appareil.
    if (!rawPayload.trim()) {
      const next = this.devices.filter((d) => d.topicId !== topicId);
      if (next.length !== this.devices.length) {
        this.devices = next;
        saveCached(next);
      }
      return;
    }
    const device = parseDevice(topicId, JSON.parse(rawPayload) as RawDevicePayload);
    const idx = this.devices.findIndex((d) => d.topicId === topicId);
    if (idx < 0) {
      this.devices = [...this.devices, device];
    } else {
      this.devices[idx] = device;
    }
    saveCached(this.devices);
  }
}

export const findmy = new FindMyState();
