/**
 * Anker store — polling REST du microservice anker-bridge sur le RPi4,
 * proxié en HTTPS via Caddy (/anker/api/status).
 *
 * Tant que le .env du bridge ne contient pas ANKER_EMAIL/ANKER_PASSWORD,
 * /api/status renvoie 503 → on garde `connected=false`. Les autres stores
 * (dashboard) basculent alors sur le mock demo-ticker.
 */

import { env } from '$env/dynamic/public';

const PUBLIC_ANKER_URL = env.PUBLIC_ANKER_URL || 'https://domo.feroux.fr/anker';

// Polling client. Le bridge Anker (RPi4) sert un CACHE rafraîchi côté cloud
// Solix toutes les ~60 s (mesuré : last_update figé 63 s puis saut). Poller plus
// vite ne livre PAS de donnée plus fraîche — c'est le mur physique. 15 s = on
// découvre chaque nouvelle mesure cloud avec ≤ 15 s de retard (vs 30 s avant)
// sans marteler le bridge. Le vrai gain de fraîcheur perçue vient du refetch
// immédiat au retour de visibilité (PWA rouverte) + pause en arrière-plan.
const POLL_INTERVAL_MS = 15_000;

export type AnkerBattery = {
  id: string;
  name: string;
  alias: string | null;
  model: string;
  soc: number;
  chargingPowerW: number;
  dischargingPowerW: number;
  outputPowerW: number;
  inputPowerW: number;
  mode: string | null;
  temperatureC: number | null;
  capacityWh: number;
  energyWh: number;
  status: string | null;
};

export type AnkerSmartMeter = {
  id: string;
  name: string | null;
  model: string;
  gridPowerW: number;
  gridToHomeW: number;
  pvToGridW: number;
  status: string | null;
};

export type AnkerSite = {
  id: string;
  name: string;
};

type ApiPayload = {
  connected: boolean;
  last_update: number | null;
  solar_power_w: number;
  grid_power_w: number;
  daily_production_wh: number;
  daily_consumption_wh: number;
  self_consumption_rate: number | null;
  lifetime_production_kwh?: number;
  lifetime_co2_saved_kg?: number;
  lifetime_savings_eur?: number;
  co2_saved_kg?: number;
  batteries: {
    id: string;
    name: string;
    alias?: string;
    model: string;
    soc: number;
    charging_power_w: number;
    discharging_power_w: number;
    output_power_w?: number;
    input_power_w?: number;
    mode: string | null;
    temperature_c: number | null;
    battery_capacity_wh?: number;
    battery_energy_wh?: number;
    status?: string;
  }[];
  smart_meter: {
    id: string;
    name?: string;
    model: string;
    grid_power_w: number;
    grid_to_home_power_w?: number;
    pv_to_grid_power_w?: number;
    status?: string;
  } | null;
  sites: { id: string; name: string }[];
};

class AnkerState {
  /** Puissance PV totale en Watts. */
  solarPowerW = $state(0);
  /** Puissance réseau : + soutirage, - injection. Watts. */
  gridPowerW = $state(0);
  batteries = $state<AnkerBattery[]>([]);
  smartMeter = $state<AnkerSmartMeter | null>(null);
  sites = $state<AnkerSite[]>([]);

  /** Production cumulée du jour (Wh) — suspect si égal au lifetime. */
  dailyProductionWh = $state(0);
  /** Consommation estimée du jour (Wh). */
  dailyConsumptionWh = $state(0);
  /** Taux d'autoconsommation 0-100. */
  selfConsumptionRate = $state<number | null>(null);

  /** Production cumulée depuis l'installation (kWh). */
  lifetimeProductionKwh = $state(0);
  /** CO₂ évité depuis l'installation (kg). */
  lifetimeCo2SavedKg = $state(0);
  /** Économies depuis l'installation (€). */
  lifetimeSavingsEur = $state(0);

  lastUpdate = $state<Date | null>(null);
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);

  /** SOC moyen des batteries (0-100), ou null si pas de batterie. */
  averageSoc = $derived(
    this.batteries.length === 0
      ? null
      : this.batteries.reduce((s, b) => s + b.soc, 0) / this.batteries.length
  );

  /** Puissance batterie nette : + charge, − décharge (W). */
  netBatteryPowerW = $derived(
    this.batteries.reduce((s, b) => s + b.chargingPowerW - b.dischargingPowerW, 0)
  );

  /** Capacité totale du parc batteries (Wh). */
  totalBatteryCapacityWh = $derived(this.batteries.reduce((s, b) => s + b.capacityWh, 0));

  /** Énergie actuellement stockée (Wh). */
  totalBatteryEnergyWh = $derived(this.batteries.reduce((s, b) => s + b.energyWh, 0));

  /** Statut batterie haut niveau pour le dashboard. */
  batteryStatus = $derived.by<'charge' | 'discharge' | 'idle'>(() => {
    const p = this.netBatteryPowerW;
    if (p > 50) return 'charge';
    if (p < -50) return 'discharge';
    return 'idle';
  });

  /**
   * Heuristique : si daily_production_wh est suspectement proche du lifetime
   * (bug du bridge cloud Anker qui mélange les deux), la valeur du jour est
   * considérée non fiable.
   */
  dailyProductionReliable = $derived.by(() => {
    if (this.lifetimeProductionKwh === 0) return true;
    const dailyKwh = this.dailyProductionWh / 1000;
    return Math.abs(dailyKwh - this.lifetimeProductionKwh) > 0.1;
  });

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.visibilityHandler !== null) return; // déjà connecté (layout + pages)
    if (!PUBLIC_ANKER_URL) {
      this.status = 'unconfigured';
      this.lastError = 'PUBLIC_ANKER_URL non défini';
      return;
    }
    // Onglet/PWA en arrière-plan → on suspend le polling (rien à afficher, et on
    // épargne le bridge). Au retour au premier plan → refetch IMMÉDIAT pour une
    // carte à jour dès la réouverture, sans attendre le prochain tick.
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.startInterval();
      } else {
        this.stopInterval();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.poll();
    this.startInterval();
  }

  disconnect() {
    this.stopInterval();
    if (this.visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private startInterval() {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopInterval() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch(`${PUBLIC_ANKER_URL}/api/status`, {
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 503) {
        this.connected = false;
        this.status = 'unconfigured';
        const body = await res.json().catch(() => ({}));
        this.lastError = (body as { detail?: string }).detail || 'service unavailable';
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiPayload;
      this.applySnapshot(json);
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      this.connected = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  private applySnapshot(p: ApiPayload) {
    this.solarPowerW = p.solar_power_w ?? 0;
    this.gridPowerW = p.grid_power_w ?? 0;
    this.dailyProductionWh = p.daily_production_wh ?? 0;
    this.dailyConsumptionWh = p.daily_consumption_wh ?? 0;
    this.selfConsumptionRate = p.self_consumption_rate;
    this.lifetimeProductionKwh = p.lifetime_production_kwh ?? 0;
    this.lifetimeCo2SavedKg = p.lifetime_co2_saved_kg ?? 0;
    this.lifetimeSavingsEur = p.lifetime_savings_eur ?? 0;

    this.batteries = (p.batteries ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      alias: b.alias ?? null,
      model: b.model,
      soc: b.soc,
      chargingPowerW: b.charging_power_w ?? 0,
      dischargingPowerW: b.discharging_power_w ?? 0,
      outputPowerW: b.output_power_w ?? 0,
      inputPowerW: b.input_power_w ?? 0,
      mode: b.mode,
      temperatureC: b.temperature_c,
      capacityWh: b.battery_capacity_wh ?? 0,
      energyWh: b.battery_energy_wh ?? 0,
      status: b.status ?? null
    }));

    this.smartMeter = p.smart_meter
      ? {
          id: p.smart_meter.id,
          name: p.smart_meter.name ?? null,
          model: p.smart_meter.model,
          gridPowerW: p.smart_meter.grid_power_w ?? 0,
          gridToHomeW: p.smart_meter.grid_to_home_power_w ?? 0,
          pvToGridW: p.smart_meter.pv_to_grid_power_w ?? 0,
          status: p.smart_meter.status ?? null
        }
      : null;

    this.sites = (p.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
  }
}

export const anker = new AnkerState();
