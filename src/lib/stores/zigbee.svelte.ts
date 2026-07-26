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
/** Back-off de réouverture du flux : 1 s, ×1,5, plafonné à 30 s (même patron
 *  que matter/client.ts). */
const REOPEN_BASE_MS = 1000;
const REOPEN_MAX_MS = 30_000;
/** Silence au-delà duquel le flux est réputé mort : ~3 battements manqués
 *  (le serveur en émet un toutes les 25 s), marge large contre le throttling
 *  des timers par iOS. */
const BEAT_STALE_MS = 70_000;

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
  /** Le flux a-t-il déjà été établi ? Distingue « pas encore connecté » (au
   *  chargement) de « on l'a perdu » — sans quoi un bandeau de panne
   *  s'afficherait à chaque ouverture de l'app. */
  everConnected = $state(false);

  private es: EventSource | null = null;
  private visibilityHandler: (() => void) | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopenDelay = REOPEN_BASE_MS;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  /** Dernier battement reçu (événement `ka` ou message). 0 = jamais. */
  private lastBeat = 0;
  /** Disponibilité par appareil, telle que Z2M la publie sur `/availability`.
   *  Conservée à part : la liste `bridge/devices` est republiée à chaque
   *  redémarrage de Z2M (dont le `docker restart` du watchdog anti-gel, toutes
   *  les 5 min) et écraserait sinon l'info par un `true` optimiste. */
  private availability = new Map<string, boolean>();

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
    if (this.visibilityHandler) return; // idempotent (plusieurs pages)

    // iOS tue les flux en arrière-plan : sans ce handler, on rouvre l'app le
    // lendemain matin et toutes les températures sont celles de la veille.
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.openStream();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.openStream();
  }

  /** Ouvre (ou rouvre) le flux. Ferme toujours le précédent d'abord. */
  private openStream() {
    if (typeof window === 'undefined') return;
    this.clearReopen();
    this.es?.close();

    this.connectionStatus = 'connecting';
    const es = new EventSource('/api/zigbee/stream');
    this.es = es;

    es.onopen = () => {
      this.connectionStatus = 'connected';
      this.lastError = null;
      this.everConnected = true;
      this.reopenDelay = REOPEN_BASE_MS; // back-off remis à zéro
    };

    // Battement applicatif : `: ka` est une ligne de COMMENTAIRE SSE, que la
    // spec impose au navigateur d'ignorer — elle n'atteint jamais JavaScript.
    // Sans cet événement nommé, impossible de distinguer « maison calme » d'un
    // flux zombie (socket ouverte, tunnel MQTT tombé) : les deux sont du silence.
    es.addEventListener('ka', () => {
      this.lastBeat = Date.now();
      this.connectionStatus = 'connected';
    });

    es.addEventListener('zigbee', (ev) => {
      this.lastBeat = Date.now();
      try {
        const { topic, payload } = JSON.parse((ev as MessageEvent).data) as {
          topic: string;
          payload: string;
        };
        if (topic === 'zigbee2mqtt/bridge/devices') {
          this.handleDeviceList(JSON.parse(payload) as BridgeDevice[]);
        } else if (topic.startsWith('zigbee2mqtt/') && !topic.includes('/bridge/')) {
          const rest = topic.slice('zigbee2mqtt/'.length);
          if (rest.endsWith('/availability')) {
            this.handleAvailability(rest.slice(0, -'/availability'.length), payload);
          } else if (rest && !rest.includes('/')) {
            this.handleDeviceState(rest, payload);
          }
        }
      } catch (e) {
        this.lastError = `parse: ${(e as Error).message}`;
      }
      this.lastUpdate = new Date();
    });

    es.onerror = () => {
      this.connectionStatus = 'disconnected';
      // `CONNECTING` : le navigateur retente de lui-même, on ne double pas.
      // `CLOSED` : il a RENONCÉ — c'est le cas qui compte. La spec ne reconnecte
      // que sur erreur de transport ; sur une réponse HTTP en erreur (502 de
      // Caddy pendant `systemctl restart domo`, 401 si le cookie a expiré) il
      // abandonne définitivement. Après chaque déploiement, l'app gardait donc à
      // l'écran tous les états restaurés du cache — figés, plausibles, faux.
      if (es.readyState === EventSource.CLOSED) this.scheduleReopen();
    };

    // Surveillance du battement : un flux zombie ne lève aucune erreur.
    this.clearBeatWatch();
    this.beatTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return; // pas de réveil inutile
      if (!this.lastBeat) return; // serveur sans « ka » (ancienne version) : on n'invente rien
      if (Date.now() - this.lastBeat > BEAT_STALE_MS) this.openStream();
    }, 10_000);
  }

  private scheduleReopen() {
    if (this.reopenTimer !== null) return;
    const delay = this.reopenDelay;
    this.reopenDelay = Math.min(REOPEN_MAX_MS, Math.round(this.reopenDelay * 1.5));
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      this.openStream();
    }, delay);
  }

  private clearReopen() {
    if (this.reopenTimer !== null) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
  }

  private clearBeatWatch() {
    if (this.beatTimer !== null) {
      clearInterval(this.beatTimer);
      this.beatTimer = null;
    }
  }

  /** Réouverture immédiate (bouton « Réessayer » d'un bandeau). */
  reconnect() {
    this.reopenDelay = REOPEN_BASE_MS;
    this.openStream();
  }

  disconnect() {
    // Les DEUX timers doivent partir : c'est exactement la fuite corrigée par
    // 40c95e6, on ne la réintroduit pas.
    this.clearReopen();
    this.clearBeatWatch();
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
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
        // La disponibilité connue PRIME sur la liste : `bridge/devices` est
        // republiée à chaque redémarrage de Z2M, ce qui ressuscitait un appareil
        // hors ligne toutes les 5 min (watchdog anti-gel).
        available: this.availability.get(friendly) ?? existing?.available ?? true,
        state: existing?.state ?? {}
      });
    }
    next.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, 'fr'));
    this.devices = next;
    saveCachedDevices(next);
  }

  /**
   * Disponibilité publiée par Z2M sur `zigbee2mqtt/<nom>/availability`.
   *
   * On ne réinvente PAS de timeout côté client : Z2M applique déjà des délais
   * très différents selon le type d'appareil (routeur sur secteur = détection
   * rapide, capteur sur pile ≈ 25 h). C'est sa décision qu'on affiche.
   */
  private handleAvailability(friendlyName: string, raw: string) {
    let s: string;
    try {
      s = String((JSON.parse(raw) as { state?: string }).state ?? raw);
    } catch {
      s = raw.trim(); // Z2M « legacy » publie la chaîne nue
    }
    const online = s === 'online';
    this.availability.set(friendlyName, online);
    const i = this.devices.findIndex((d) => d.friendlyName === friendlyName);
    if (i >= 0) {
      this.devices[i] = { ...this.devices[i], available: online };
      saveCachedDevices(this.devices);
    }
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
    // `available: parsed.available !== false` a été RETIRÉ : aucun payload
    // d'état Z2M ne contient de champ `available` (l'info vit sur le topic
    // `/availability`), donc l'expression valait toujours `undefined !== false`
    // = true. C'était la ligne exacte qui rendait le drapeau incapable de passer
    // à false : un capteur mort restait affiché comme vivant, avec sa dernière
    // valeur. On ne la remplace pas non plus par un horodatage de réception :
    // le snapshot retained rejoue de vieux payloads à chaque (re)connexion, on
    // mesurerait l'âge de la connexion et pas celui de la mesure.
    this.devices[idx] = {
      ...this.devices[idx],
      state: { ...this.devices[idx].state, ...parsed }
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
