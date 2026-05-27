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

const POLL_INTERVAL_MS = 30_000;

export type AnkerBattery = {
  id: string;
  name: string;
  model: string;
  soc: number;
  chargingPowerW: number;
  dischargingPowerW: number;
  mode: string | null;
  temperatureC: number | null;
};

type ApiPayload = {
  connected: boolean;
  last_update: number | null;
  solar_power_w: number;
  grid_power_w: number;
  daily_production_wh: number;
  daily_consumption_wh: number;
  self_consumption_rate: number | null;
  batteries: {
    id: string;
    name: string;
    model: string;
    soc: number;
    charging_power_w: number;
    discharging_power_w: number;
    mode: string | null;
    temperature_c: number | null;
  }[];
  smart_meter: { id: string; model: string; grid_power_w: number } | null;
  sites: { id: string; name: string }[];
};

class AnkerState {
  /** Puissance PV totale en Watts. */
  solarPowerW = $state(0);
  /** Puissance réseau : + soutirage, - injection. Watts. */
  gridPowerW = $state(0);
  batteries = $state<AnkerBattery[]>([]);
  /** Production cumulée du jour (Wh). */
  dailyProductionWh = $state(0);
  /** Consommation estimée du jour (Wh). */
  dailyConsumptionWh = $state(0);
  /** Taux d'autoconsommation 0-100. */
  selfConsumptionRate = $state<number | null>(null);
  lastUpdate = $state<Date | null>(null);
  /** true si le dernier poll a réussi. */
  connected = $state(false);
  /** Statut détaillé. */
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);

  /** SOC moyen des batteries (0-100), ou null si pas de batterie. */
  averageSoc = $derived(
    this.batteries.length === 0
      ? null
      : this.batteries.reduce((s, b) => s + b.soc, 0) / this.batteries.length
  );

  /** Puissance batterie nette (charge positive, décharge négative). */
  netBatteryPowerW = $derived(
    this.batteries.reduce((s, b) => s + b.chargingPowerW - b.dischargingPowerW, 0)
  );

  /** Statut batterie haut niveau pour le dashboard. */
  batteryStatus = $derived.by<'charge' | 'discharge' | 'idle'>(() => {
    const p = this.netBatteryPowerW;
    if (p > 50) return 'charge';
    if (p < -50) return 'discharge';
    return 'idle';
  });

  private intervalId: ReturnType<typeof setInterval> | null = null;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.intervalId !== null) return;
    if (!PUBLIC_ANKER_URL) {
      this.status = 'unconfigured';
      this.lastError = 'PUBLIC_ANKER_URL non défini';
      return;
    }
    this.poll();
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  disconnect() {
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
    this.batteries = (p.batteries ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      model: b.model,
      soc: b.soc,
      chargingPowerW: b.charging_power_w,
      dischargingPowerW: b.discharging_power_w,
      mode: b.mode,
      temperatureC: b.temperature_c
    }));
  }
}

export const anker = new AnkerState();
