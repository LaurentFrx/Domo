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

/** Une phase d'installation datée (matériel ajouté en plusieurs fois). */
export type InstallationPhase = {
  id: string;
  label: string;
  dateISO: string; // 'YYYY-MM-DD'
  costEur: number;
};

let phaseSeq = 0;
/** Id stable pour les clés #each (unique dans la session). */
function genPhaseId(): string {
  phaseSeq += 1;
  return `ph_${phaseSeq}`;
}

type Persisted = {
  priceHc: number;
  priceHp: number;
  priceExport: number;
  subscription: number;
  /**
   * Phases d'installation datées (le matériel a été ajouté en plusieurs fois).
   * Coût total ROI = somme des coûts ; le taux d'économie est projeté depuis la
   * 1ʳᵉ date de mise en service.
   */
  installationPhases: InstallationPhase[];
  /** Config de régulation du thermostat sèche-serviette (miroir poussé au daemon). */
  thermostat: ThermostatConfig;
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);

/** Normalise une phase issue d'un JSON partiel (id régénéré si absent). */
function normalizePhase(p: Partial<InstallationPhase> | undefined): InstallationPhase {
  return {
    id: typeof p?.id === 'string' && p.id ? p.id : genPhaseId(),
    label: typeof p?.label === 'string' ? p.label : '',
    dateISO: typeof p?.dateISO === 'string' ? p.dateISO : '',
    costEur: Math.max(0, num(p?.costEur, 0))
  };
}
function normalizePhases(arr: unknown): InstallationPhase[] {
  return Array.isArray(arr) ? arr.map((p) => normalizePhase(p as Partial<InstallationPhase>)) : [];
}

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

const DEFAULT_PHASES: InstallationPhase[] = [
  { id: 'ph_init', label: 'Installation', dateISO: '2025-05-05', costEur: 0 }
];

const DEFAULTS: Persisted = {
  priceHc: 0.1812,
  priceHp: 0.2318,
  priceExport: 0.04,
  subscription: 13.5,
  installationPhases: DEFAULT_PHASES,
  thermostat: DEFAULT_THERMOSTAT_CONFIG
};

class SettingsState {
  priceHc = $state(DEFAULTS.priceHc);
  priceHp = $state(DEFAULTS.priceHp);
  priceExport = $state(DEFAULTS.priceExport);
  subscription = $state(DEFAULTS.subscription);
  installationPhases = $state<InstallationPhase[]>(DEFAULT_PHASES.map((p) => ({ ...p })));
  /** Config thermostat — objet réactif profond (bindable champ par champ). */
  thermostat = $state<ThermostatConfig>(mergeThermostat({}));

  /** true pendant le fetch initial — évite de save pendant hydrate. */
  hydrating = $state(false);
  /** true pendant un save en cours. Affichable dans l'UI si besoin. */
  saving = $state(false);
  /** Dernière erreur réseau (null si OK). */
  lastError = $state<string | null>(null);

  /** Coût total de l'installation = somme des phases (€). */
  get installationTotalEur(): number {
    return this.installationPhases.reduce(
      (s, p) => s + (Number.isFinite(p.costEur) ? p.costEur : 0),
      0
    );
  }
  /** Date de la 1ʳᵉ mise en service (la plus ancienne) — réf. du taux d'économie. */
  get firstInstallationDateISO(): string {
    const ds = this.installationPhases
      .map((p) => p.dateISO)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    return ds[0] ?? DEFAULT_PHASES[0].dateISO;
  }

  /** Ajoute une phase vierge (datée comme la 1ʳᵉ par défaut) et persiste. */
  addPhase() {
    this.installationPhases = [
      ...this.installationPhases,
      { id: genPhaseId(), label: '', dateISO: this.firstInstallationDateISO, costEur: 0 }
    ];
    this.save();
  }
  /** Retire une phase par id et persiste (garde toujours au moins une phase). */
  removePhase(id: string) {
    if (this.installationPhases.length <= 1) return;
    this.installationPhases = this.installationPhases.filter((p) => p.id !== id);
    this.save();
  }

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
      const legacy = data as Partial<Persisted> & {
        installationCostEur?: number;
        installationDateISO?: string;
      };
      if (Array.isArray(legacy.installationPhases)) {
        const phases = normalizePhases(legacy.installationPhases);
        if (phases.length > 0) this.installationPhases = phases;
      } else if (typeof legacy.installationCostEur === 'number') {
        // Ancien format (coût + date unique) → migration en une phase.
        this.installationPhases = [
          {
            id: genPhaseId(),
            label: 'Installation',
            dateISO: legacy.installationDateISO || DEFAULT_PHASES[0].dateISO,
            costEur: Math.max(0, legacy.installationCostEur)
          }
        ];
      }
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
          installationPhases: $state.snapshot(this.installationPhases),
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
