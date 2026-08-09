/**
 * Store Anker Solix LOCAL (Modbus TCP via /api/anker-local/status) — Smart
 * Meter Gen 2 seul (réseau signé, contrôle croisé du EM-50). Lecture 100 %
 * locale : ni le cloud Solix, ni sa latence ~60 s, ni ses SoC fantômes.
 *
 * Le bloc Solarbank Max AC a disparu le 09/08/2026 avec la batterie elle-même.
 *
 * Calqué STRICTEMENT sur le store em50 : poll 10 s visibility-aware (pause en
 * arrière-plan + refetch au retour au premier plan), conserve le dernier
 * snapshot en cas d'erreur réseau (la route répond 200 quoi qu'il arrive,
 * `available` fait foi).
 *
 * Convention de signe (alignée EM-50) :
 *   meterGridPowerW : + soutirage EDF / − injection PV.
 */

// ─── Contrat de /api/anker-local/status ─────────────────────────────────
interface MeterBlock {
  available: boolean;
  grid_power_w: number;
  voltage_v: number;
}

interface AnkerLocalStatus {
  meter: MeterBlock;
  em50_grid_w: number | null;
  grid_deviation_w: number | null;
  ts: number;
}

// 10 s : lecture LOCALE (Modbus LAN via tunnel), sans cache cloud → même
// rationale que le store em50, distinct du store anker bridé à ~60 s par le
// cloud Solix. Pause en arrière-plan + refetch au retour de visibilité.
const REFRESH_MS = 10_000;
const TIMEOUT_MS = 9_000;

const EMPTY: AnkerLocalStatus = {
  meter: { available: false, grid_power_w: 0, voltage_v: 0 },
  em50_grid_w: null,
  grid_deviation_w: null,
  ts: 0
};

class AnkerLocalState {
  /** Dernier instantané connu (conservé en cas d'erreur réseau). */
  #snap = $state<AnkerLocalStatus>(EMPTY);
  /** Vrai tant qu'un fetch a réussi récemment (la route répond). */
  #ok = $state(false);

  status = $state<'idle' | 'live' | 'error'>('idle');
  lastError = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;
  /** Cadence de poll courante (ms). Boostée par setBoost() sur l'accueil (le SoC
   *  et le flux batterie affichés viennent d'ici quand le local est up) ;
   *  REFRESH_MS par défaut. Lecture Modbus LAN sans cache cloud → poller vite
   *  livre une vraie fraîcheur (même mécanique que le store em50). */
  #intervalMs: number = REFRESH_MS;

  // ─── Getters exposés au front ─────────────────────────────────────────
  /** La route répond (dernier poll réussi). */
  get connected(): boolean {
    return this.#ok;
  }

  // Smart Meter Gen 2 (contrôle croisé du EM-50 — PAS la source de vérité)
  /** Meter joignable en Modbus local. */
  get meterAvailable(): boolean {
    return this.#ok && this.#snap.meter.available;
  }
  /** Réseau signé vu par le Gen 2 (W) : + soutirage EDF / − injection PV. */
  get meterGridPowerW(): number {
    return this.#snap.meter.grid_power_w;
  }
  /** Tension secteur vue par le Gen 2 (V). */
  get meterVoltageV(): number {
    return this.#snap.meter.voltage_v;
  }
  /** Réseau signé vu par le EM-50 au même poll (W), null si indisponible. */
  get em50GridW(): number | null {
    return this.#snap.em50_grid_w;
  }
  /** |Gen 2 − EM-50| (W), null si l'un des deux manque. */
  get gridDeviationW(): number | null {
    return this.#snap.grid_deviation_w;
  }
  /** Horodatage epoch (s) de la mesure. */
  get ts(): number {
    return this.#snap.ts;
  }

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    if (this.#visibilityHandler !== null) return; // idempotent
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
   * Accélère la cadence de poll (ms) tant qu'une page « regarde » la batterie en
   * direct (accueil). Même contrat que em50.setBoost : #stop() AVANT #start()
   * pour que la cadence change réellement ; le #visibilityHandler relit
   * #intervalMs, donc le boost survit à un aller-retour arrière-plan. NE PAS
   * mettre dans connect() (rappels idempotents app-wide).
   */
  setBoost(ms: number) {
    if (ms === this.#intervalMs) return;
    this.#intervalMs = ms;
    if (this.#timer) {
      this.#stop();
      this.#start();
    }
    this.poll(); // tick immédiat : la 1re lecture rapide n'attend pas `ms`
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
      const res = await fetch('/api/anker-local/status', {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AnkerLocalStatus;
      this.#snap = {
        meter: { ...EMPTY.meter, ...data.meter },
        em50_grid_w: data.em50_grid_w ?? null,
        grid_deviation_w: data.grid_deviation_w ?? null,
        ts: data.ts ?? 0
      };
      this.#ok = true;
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // On garde le dernier snapshot, mais la donnée n'est plus fraîche.
      this.#ok = false;
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const ankerLocal = new AnkerLocalState();
