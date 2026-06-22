/**
 * Store « santé de la liaison domotique » — alimente le bandeau d'alerte global
 * (HealthBanner). Poll la route serveur /api/health qui renvoie l'état du hub
 * MQTT (capteurs Zigbee, sonde cumulus, portail), proxy fiable de « plus aucune
 * connexion avec mon système » lors d'une coupure des tunnels reverse RPi4.
 *
 * Délai de grâce avant d'alerter : la cause infra s'auto-répare (watchdog VPS +
 * reconnexion MQTT ~5 s). On n'affiche le bandeau que si la panne PERSISTE
 * au-delà de GRACE_MS — c.-à-d. quand l'auto-réparation a échoué (ex. RPi sans
 * réseau), le seul cas où Laurent doit vraiment être prévenu.
 *
 * Échec du fetch lui-même = très probablement le réseau DU CLIENT (téléphone
 * hors ligne), pas la domotique → on n'allume PAS le bandeau dans ce cas, ce
 * serait trompeur. Voir le pattern visibility-aware de apsystems.svelte.ts.
 */

interface HealthResponse {
  mqtt: boolean;
  ts: number;
}

const REFRESH_MS = 30_000; // lecture mémoire serveur → pas besoin de poller vite
const TIMEOUT_MS = 10_000;
const GRACE_MS = 180_000; // 3 min : laisse l'auto-réparation faire son travail

class HealthState {
  /** Liaison MQTT vue du serveur (optimiste au démarrage : pas de flash). */
  #mqtt = $state(true);
  /** Premier instant (epoch ms) d'une déconnexion confirmée, sinon null. */
  #downSince = $state<number | null>(null);
  /** Horloge rafraîchie à chaque poll pour faire avancer la durée affichée. */
  #now = $state(0);

  status = $state<'idle' | 'live' | 'error'>('idle');

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  // ─── Getters exposés au bandeau ───────────────────────────────────────
  /** Vrai si la liaison est tombée ET le persiste au-delà du délai de grâce. */
  get linkDown(): boolean {
    return this.#downSince !== null && this.#now - this.#downSince >= GRACE_MS;
  }
  /** Durée de la coupure en minutes (≥ 1), pour le texte du bandeau. */
  get downMinutes(): number {
    if (this.#downSince === null) return 0;
    return Math.max(1, Math.round((this.#now - this.#downSince) / 60_000));
  }

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    if (this.#visibilityHandler !== null) return; // idempotent (layout)
    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.#start();
      } else {
        this.#stop();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    this.poll();
    this.#start();
  }

  disconnect() {
    this.#stop();
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #start() {
    this.#timer ??= setInterval(() => this.poll(), REFRESH_MS);
  }

  #stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async poll() {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthResponse;
      this.#now = Date.now();
      this.#mqtt = data.mqtt;
      if (data.mqtt) {
        this.#downSince = null; // liaison OK → on efface la coupure
      } else if (this.#downSince === null) {
        this.#downSince = this.#now; // début d'une coupure confirmée par le serveur
      }
      this.status = 'live';
    } catch {
      // Réseau client probablement coupé : on ne touche pas à #downSince
      // (ne pas accuser la domotique d'une panne côté téléphone).
      this.status = 'error';
    }
  }
}

export const health = new HealthState();
