/**
 * Store Anker Solix LOCAL (Modbus TCP via /api/anker-local/status) — Solarbank
 * Max AC (SOC, flux, mode) + Smart Meter Gen 2 (réseau signé, contrôle croisé
 * du EM-50). Lecture 100 % locale : ni le cloud Solix, ni sa latence ~60 s,
 * ni ses SoC fantômes — c'est le pendant temps réel du store `anker` (cloud).
 *
 * Calqué STRICTEMENT sur le store em50 : poll 10 s visibility-aware (pause en
 * arrière-plan + refetch au retour au premier plan), conserve le dernier
 * snapshot en cas d'erreur réseau, disponibilité par device dans le payload
 * (un device down ne masque pas l'autre — la route répond 200 quoi qu'il
 * arrive, `available` fait foi par bloc).
 *
 * Conventions de signe (alignées EM-50) :
 *   meterGridPowerW : + soutirage EDF / − injection PV ;
 *   batteryPowerW / acPowerW : + décharge vers la maison / − charge.
 */

// ─── Contrat de /api/anker-local/status ─────────────────────────────────
interface SolarbankBlock {
  available: boolean;
  soc_pct: number;
  battery_power_w: number;
  ac_power_w: number;
  pv_power_w: number;
  load_power_w: number;
  battery_status: 'standby' | 'charging' | 'discharging' | 'sleep' | 'unknown';
  mode: string;
  mode_raw: number;
}

interface MeterBlock {
  available: boolean;
  grid_power_w: number;
  voltage_v: number;
}

interface AnkerLocalStatus {
  solarbank: SolarbankBlock;
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
  solarbank: {
    available: false,
    soc_pct: 0,
    battery_power_w: 0,
    ac_power_w: 0,
    pv_power_w: 0,
    load_power_w: 0,
    battery_status: 'unknown',
    mode: 'unknown',
    mode_raw: -1
  },
  meter: { available: false, grid_power_w: 0, voltage_v: 0 },
  em50_grid_w: null,
  grid_deviation_w: null,
  ts: 0
};

/** Libellés FR des modes de la Solarbank (clés du YAML officiel Anker). */
const MODE_LABELS: Record<string, string> = {
  self_consumption: 'Autoconsommation',
  tou_mode: 'Heures creuses',
  third_party_control: 'Pilotage externe',
  custom_mode: 'Personnalisé',
  socket_overlay_mode: 'Prise pilotée',
  smart_mode: 'Intelligent',
  dynamic_pricing: 'Tarif dynamique'
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

  // ─── Getters exposés au front ─────────────────────────────────────────
  /** La route répond (dernier poll réussi). */
  get connected(): boolean {
    return this.#ok;
  }

  // Solarbank Max AC
  /** Solarbank joignable en Modbus local. */
  get sbAvailable(): boolean {
    return this.#ok && this.#snap.solarbank.available;
  }
  /** État de charge batterie (%). */
  get socPct(): number {
    return this.#snap.solarbank.soc_pct;
  }
  /** Puissance batterie signée (W) : + décharge vers la maison / − charge. */
  get batteryPowerW(): number {
    return this.#snap.solarbank.battery_power_w;
  }
  /** Sortie AC signée (W), même convention que batteryPowerW. */
  get acPowerW(): number {
    return this.#snap.solarbank.ac_power_w;
  }
  /** PV total vu par la Solarbank (W). */
  get pvPowerW(): number {
    return this.#snap.solarbank.pv_power_w;
  }
  /** Conso maison vue par la Solarbank (W). */
  get loadPowerW(): number {
    return this.#snap.solarbank.load_power_w;
  }
  /** État batterie brut (standby / charging / discharging / sleep / unknown). */
  get batteryStatus(): SolarbankBlock['battery_status'] {
    return this.#snap.solarbank.battery_status;
  }
  /** Mode actif (clé technique, ex. self_consumption). */
  get mode(): string {
    return this.#snap.solarbank.mode;
  }
  /** Mode actif en français (pour l'UI). */
  get modeLabel(): string {
    return MODE_LABELS[this.#snap.solarbank.mode] ?? this.#snap.solarbank.mode;
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
      const res = await fetch('/api/anker-local/status', {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AnkerLocalStatus;
      this.#snap = {
        solarbank: { ...EMPTY.solarbank, ...data.solarbank },
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
