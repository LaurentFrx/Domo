/**
 * Store production PV instantanée — onduleur APsystems EZ1 via apsystems-bridge
 * (RPi4, loopback 8100), proxifié server-side par /api/apsystems/status.
 * Calqué sur le pattern forecast/airzone : le bridge n'est jamais exposé au
 * navigateur ; le client poll une route relative, relayée server-to-server.
 *
 * Mesure INSTANTANÉE (pas de série temporelle). Hors-ligne (onduleur éteint la
 * nuit) → `available:false` et `powerW` forcé à 0.
 */

// ─── Contrat du bridge (/api/apsystems/status) ──────────────────────────
interface BridgeStatus {
  available: boolean;
  power_w: number;
  p1_w: number;
  p2_w: number;
  today_kwh: number;
  lifetime_kwh: number | null;
  ts: number;
}

// 10 s : l'onduleur EZ1 est lu en LOCAL (LAN du RPi4) et le bridge ne cache que
// 5 s → poller vite livre vraiment une prod plus fraîche (contrairement au store
// anker, bridé à ~60 s par le cloud Solix). Pause en arrière-plan + refetch au
// retour de visibilité gérés dans connect(). Le store forecast, lui, poll à
// 5 min (Open-Meteo ne bouge que toutes les 30 min) — rationale distinct.
const REFRESH_MS = 10_000;
const TIMEOUT_MS = 14_000;

const EMPTY: BridgeStatus = {
  available: false,
  power_w: 0,
  p1_w: 0,
  p2_w: 0,
  today_kwh: 0,
  lifetime_kwh: null,
  ts: 0
};

class ApsystemsState {
  /** Dernier instantané connu (conservé en cas d'erreur réseau). */
  #snap = $state<BridgeStatus>(EMPTY);

  status = $state<'idle' | 'live' | 'error'>('idle');
  lastError = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;
  /** Cadence de poll courante (ms) ; boostée par setBoost() sur une page qui
   *  regarde la prod en direct (accueil/comparatif), REFRESH_MS par défaut. */
  #intervalMs: number = REFRESH_MS;

  // ─── Getters exposés au front ─────────────────────────────────────────
  /** Onduleur joignable et éveillé. */
  get available(): boolean {
    return this.#snap.available;
  }
  /** Puissance PV instantanée totale (W). 0 si indisponible (nuit). */
  get powerW(): number {
    return this.#snap.available ? this.#snap.power_w : 0;
  }
  /** Puissance PV entrée 1 (W). 0 si indisponible. */
  get p1W(): number {
    return this.#snap.available ? this.#snap.p1_w : 0;
  }
  /** Puissance PV entrée 2 (W). 0 si indisponible. */
  get p2W(): number {
    return this.#snap.available ? this.#snap.p2_w : 0;
  }
  /** Énergie produite aujourd'hui (kWh). */
  get todayKwh(): number {
    return this.#snap.today_kwh;
  }
  /** Énergie cumulée depuis l'installation (kWh), ou null si jamais relevée. */
  get lifetimeKwh(): number | null {
    return this.#snap.lifetime_kwh;
  }
  /** Horodatage epoch (s) de la mesure côté bridge. */
  get ts(): number {
    return this.#snap.ts;
  }

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    if (this.#visibilityHandler !== null) return; // idempotent (layout + page)
    // Arrière-plan → on suspend ; retour au premier plan → refetch immédiat.
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
    this.#timer ??= setInterval(() => this.poll(), this.#intervalMs);
  }

  #stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Accélère la cadence de poll (ms). ⚠️ Ne PAS booster sous ~5 s : le bridge APS
   * cache ~5 s (2,5 s = ~50 % de polls redondants + charge doublée inutile sur le
   * tunnel 8100). À appeler en onMount, annuler via clearBoost() en onDestroy.
   * #stop() AVANT #start() (le `??=` de #start sinon ne change pas la cadence).
   */
  setBoost(ms: number) {
    if (ms === this.#intervalMs) return;
    this.#intervalMs = ms;
    if (this.#timer) {
      this.#stop();
      this.#start();
    }
    this.poll();
  }

  /** Restaure la cadence par défaut (REFRESH_MS). */
  clearBoost() {
    if (this.#intervalMs === REFRESH_MS) return;
    this.#intervalMs = REFRESH_MS;
    if (this.#timer) {
      this.#stop();
      this.#start();
    }
  }

  async poll() {
    try {
      const res = await fetch('/api/apsystems/status', {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BridgeStatus;
      this.#snap = {
        available: data.available ?? false,
        power_w: data.power_w ?? 0,
        p1_w: data.p1_w ?? 0,
        p2_w: data.p2_w ?? 0,
        today_kwh: data.today_kwh ?? 0,
        lifetime_kwh: data.lifetime_kwh ?? null,
        ts: data.ts ?? 0
      };
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // on garde le dernier état connu ; on signale juste l'erreur
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const apsystems = new ApsystemsState();
