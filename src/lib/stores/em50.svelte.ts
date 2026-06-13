/**
 * Store compteur Shelly Pro EM-50 — 2 voies : réseau EDF (act_power signé) +
 * conso cumulus. Lit /api/em50/status, relayé server-side (le device n'est
 * jamais exposé au navigateur ; cf. le tunnel SSH inverse 8102 → 192.168.1.54).
 *
 * Calqué STRICTEMENT sur le store apsystems : poll visibility-aware (pause en
 * arrière-plan + refetch au retour au premier plan), conserve le dernier
 * snapshot en cas d'erreur réseau, état `available` propre si injoignable.
 *
 * Différence assumée vs apsystems : le EM50 est toujours alimenté (pas de cas
 * légitime « available:false » comme l'onduleur la nuit) → on ne déduit
 * l'indisponibilité QUE d'une erreur réseau/HTTP.
 *
 * grid_power_w SIGNÉ : + soutirage EDF / − injection PV.
 */

// ─── Contrat de /api/em50/status ────────────────────────────────────────
interface Em50Status {
  available: boolean;
  /** Réseau signé (W) : + soutirage EDF / − injection PV. */
  grid_power_w: number;
  grid_voltage_v: number;
  /** Cumul import réseau depuis l'install du compteur (kWh). */
  grid_import_kwh: number;
  /** Cumul export/injection depuis l'install du compteur (kWh). */
  grid_export_kwh: number;
  cumulus_power_w: number;
  cumulus_current_a: number;
  /** Cumul conso cumulus depuis l'install du compteur (kWh). */
  cumulus_kwh: number;
  ts: number;
}

// 10 s : le EM50 est lu en LOCAL (LAN du RPi4), mesure temps réel sans cache →
// poller vite livre une vraie fraîcheur (même rationale que le store apsystems,
// distinct du store anker bridé à ~60 s par le cloud Solix). Pause en
// arrière-plan + refetch au retour de visibilité gérés dans connect().
const REFRESH_MS = 10_000;
const TIMEOUT_MS = 9_000;

const EMPTY: Em50Status = {
  available: false,
  grid_power_w: 0,
  grid_voltage_v: 0,
  grid_import_kwh: 0,
  grid_export_kwh: 0,
  cumulus_power_w: 0,
  cumulus_current_a: 0,
  cumulus_kwh: 0,
  ts: 0
};

class Em50State {
  /** Dernier instantané connu (conservé en cas d'erreur réseau). */
  #snap = $state<Em50Status>(EMPTY);
  /** Vrai tant qu'un fetch a réussi récemment ; faux si le device est injoignable. */
  #ok = $state(false);

  status = $state<'idle' | 'live' | 'error'>('idle');
  lastError = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  // ─── Getters exposés au front ─────────────────────────────────────────
  /** Compteur joignable (dernier poll réussi). */
  get available(): boolean {
    return this.#ok;
  }
  /** Réseau signé (W) : + soutirage EDF / − injection PV. */
  get gridPowerW(): number {
    return this.#snap.grid_power_w;
  }
  /** Soutirage EDF instantané (W, ≥ 0). */
  get gridImportingW(): number {
    return Math.max(0, this.#snap.grid_power_w);
  }
  /** Injection PV instantanée (W, ≥ 0). */
  get gridExportingW(): number {
    return Math.max(0, -this.#snap.grid_power_w);
  }
  /** Tension secteur (V). */
  get gridVoltageV(): number {
    return this.#snap.grid_voltage_v;
  }
  /** Cumul import réseau (kWh) depuis l'install du compteur. */
  get gridImportKwh(): number {
    return this.#snap.grid_import_kwh;
  }
  /** Cumul export/injection (kWh) depuis l'install du compteur. */
  get gridExportKwh(): number {
    return this.#snap.grid_export_kwh;
  }
  /** Puissance instantanée du cumulus (W). */
  get cumulusPowerW(): number {
    return this.#snap.cumulus_power_w;
  }
  /** Le cumulus consomme-t-il (> 50 W = chauffe en cours) ? */
  get cumulusHeating(): boolean {
    return this.#snap.cumulus_power_w > 50;
  }
  /** Courant cumulus (A). */
  get cumulusCurrentA(): number {
    return this.#snap.cumulus_current_a;
  }
  /** Cumul conso cumulus (kWh) depuis l'install du compteur. */
  get cumulusKwh(): number {
    return this.#snap.cumulus_kwh;
  }
  /** Horodatage epoch (s) de la mesure. */
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
      const res = await fetch('/api/em50/status', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Em50Status;
      this.#snap = {
        available: data.available ?? false,
        grid_power_w: data.grid_power_w ?? 0,
        grid_voltage_v: data.grid_voltage_v ?? 0,
        grid_import_kwh: data.grid_import_kwh ?? 0,
        grid_export_kwh: data.grid_export_kwh ?? 0,
        cumulus_power_w: data.cumulus_power_w ?? 0,
        cumulus_current_a: data.cumulus_current_a ?? 0,
        cumulus_kwh: data.cumulus_kwh ?? 0,
        ts: data.ts ?? 0
      };
      this.#ok = true;
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // On garde le dernier snapshot pour l'historique, mais on signale que la
      // donnée n'est plus fraîche (le EM50 est toujours censé répondre).
      this.#ok = false;
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const em50 = new Em50State();
