/**
 * Settings store — valeurs métier partagées **cross-device** via le serveur.
 *
 * Sync via GET/PUT /api/settings (fichier JSON côté Node, voir
 * lib/server/settings-store.ts).
 *
 * À distinguer de `preferences.svelte.ts` qui reste en localStorage
 * (préférences UI per-device : theme, animations, unité d'affichage).
 */

import { DEFAULT_THERMOSTAT_CONFIG, type ThermostatConfig } from './thermostat.svelte';

type Persisted = {
  priceHc: number;
  priceHp: number;
  priceExport: number;
  subscription: number;
  /** Coût total de l'installation PV+batterie (€) — sert au calcul du ROI. */
  installationCostEur: number;
  /** Date de mise en service 'YYYY-MM-DD' — sert au taux d'économie annuel réalisé. */
  installationDateISO: string;
  /**
   * Facteur d'émission CO2 de l'électricité réseau (kgCO2e/kWh) — pour le CO2 évité.
   * Défaut 0,052 : ADEME Base Empreinte, mix moyen de CONSOMMATION France (pertes
   * réseau incluses). Bien plus bas que les ~0,5 « génériques » (mix européen) de
   * l'app Anker, car l'électricité française est très bas carbone (nucléaire).
   */
  co2FactorKgKwh: number;
  /** Config de régulation du thermostat sèche-serviette (miroir poussé au daemon). */
  thermostat: ThermostatConfig;
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * Reconstruit une config thermostat COMPLÈTE depuis un JSON partiel : tout champ
 * manquant ou invalide retombe sur le défaut. Sert au seed initial et à
 * l'hydratation (le fichier settings.json peut être ancien/partiel).
 */
function mergeThermostat(p: Partial<ThermostatConfig>): ThermostatConfig {
  const d = DEFAULT_THERMOSTAT_CONFIG;
  const pt = (p.presetTemps ?? {}) as Partial<ThermostatConfig['presetTemps']>;
  return {
    presetTemps: {
      frost: num(pt.frost, d.presetTemps.frost),
      eco: num(pt.eco, d.presetTemps.eco),
      comfort: num(pt.comfort, d.presetTemps.comfort),
      boost: num(pt.boost, d.presetTemps.boost)
    },
    coefInt: num(p.coefInt, d.coefInt),
    coefExt: num(p.coefExt, d.coefExt),
    cycleSec: num(p.cycleSec, d.cycleSec),
    boostDefaultMin: num(p.boostDefaultMin, d.boostDefaultMin),
    minTempC: num(p.minTempC, d.minTempC),
    maxTempC: num(p.maxTempC, d.maxTempC),
    windowDropC: num(p.windowDropC, d.windowDropC),
    windowDropMin: num(p.windowDropMin, d.windowDropMin),
    preheatMin: num(p.preheatMin, d.preheatMin)
  };
}

const DEFAULTS: Persisted = {
  priceHc: 0.1812,
  priceHp: 0.2318,
  priceExport: 0.04,
  subscription: 13.5,
  installationCostEur: 4500,
  installationDateISO: '2025-06-01',
  co2FactorKgKwh: 0.052,
  thermostat: DEFAULT_THERMOSTAT_CONFIG
};

class SettingsState {
  priceHc = $state(DEFAULTS.priceHc);
  priceHp = $state(DEFAULTS.priceHp);
  priceExport = $state(DEFAULTS.priceExport);
  subscription = $state(DEFAULTS.subscription);
  installationCostEur = $state(DEFAULTS.installationCostEur);
  installationDateISO = $state(DEFAULTS.installationDateISO);
  co2FactorKgKwh = $state(DEFAULTS.co2FactorKgKwh);
  /** Config thermostat — objet réactif profond (bindable champ par champ). */
  thermostat = $state<ThermostatConfig>(mergeThermostat({}));

  /** true pendant le fetch initial — évite de save pendant hydrate. */
  hydrating = $state(false);
  /** true pendant un save en cours. Affichable dans l'UI si besoin. */
  saving = $state(false);
  /** Dernière erreur réseau (null si OK). */
  lastError = $state<string | null>(null);

  async hydrate() {
    if (typeof window === 'undefined') return;
    this.hydrating = true;
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<Persisted>;
      if (typeof data.priceHc === 'number') this.priceHc = data.priceHc;
      if (typeof data.priceHp === 'number') this.priceHp = data.priceHp;
      if (typeof data.priceExport === 'number') this.priceExport = data.priceExport;
      if (typeof data.subscription === 'number') this.subscription = data.subscription;
      if (typeof data.installationCostEur === 'number')
        this.installationCostEur = data.installationCostEur;
      if (typeof data.installationDateISO === 'string' && data.installationDateISO)
        this.installationDateISO = data.installationDateISO;
      if (typeof data.co2FactorKgKwh === 'number') this.co2FactorKgKwh = data.co2FactorKgKwh;
      if (data.thermostat && typeof data.thermostat === 'object')
        this.thermostat = mergeThermostat(data.thermostat as Partial<ThermostatConfig>);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.hydrating = false;
    }
  }

  async save() {
    if (typeof window === 'undefined') return;
    if (this.hydrating) return;
    this.saving = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceHc: this.priceHc,
          priceHp: this.priceHp,
          priceExport: this.priceExport,
          subscription: this.subscription,
          installationCostEur: this.installationCostEur,
          installationDateISO: this.installationDateISO,
          co2FactorKgKwh: this.co2FactorKgKwh,
          thermostat: $state.snapshot(this.thermostat)
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.saving = false;
    }
  }
}

export const settings = new SettingsState();
