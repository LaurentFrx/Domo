/**
 * Préférences utilisateur — persistées en localStorage côté client.
 * Mock pour l'instant : pvThreshold et hcMinTemp préparent la connexion
 * future au pilotage Cumulus.
 */

import { startDemoTicker, stopDemoTicker } from './demo-ticker.svelte';

const STORAGE_KEY = 'domo.preferences.v1';

type PowerUnit = 'kW' | 'W';

type Persisted = {
  pvThreshold: number;
  hcMinTemp: number;
  powerUnit: PowerUnit;
  animationsEnabled: boolean;
};

const DEFAULTS: Persisted = {
  pvThreshold: 1500,
  hcMinTemp: 45,
  powerUnit: 'kW',
  animationsEnabled: true
};

function load(): Persisted {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

class PreferencesState {
  pvThreshold = $state(DEFAULTS.pvThreshold);
  hcMinTemp = $state(DEFAULTS.hcMinTemp);
  powerUnit = $state<PowerUnit>(DEFAULTS.powerUnit);
  animationsEnabled = $state(DEFAULTS.animationsEnabled);

  hydrate() {
    if (typeof window === 'undefined') return;
    const p = load();
    this.pvThreshold = p.pvThreshold;
    this.hcMinTemp = p.hcMinTemp;
    this.powerUnit = p.powerUnit;
    this.animationsEnabled = p.animationsEnabled;
  }

  persist() {
    if (typeof window === 'undefined') return;
    const snap: Persisted = {
      pvThreshold: this.pvThreshold,
      hcMinTemp: this.hcMinTemp,
      powerUnit: this.powerUnit,
      animationsEnabled: this.animationsEnabled
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // localStorage indisponible (mode privé) : on accepte la perte.
    }
  }

  setPvThreshold(v: number) {
    this.pvThreshold = v;
    this.persist();
  }
  setHcMinTemp(v: number) {
    this.hcMinTemp = v;
    this.persist();
  }
  setPowerUnit(u: PowerUnit) {
    this.powerUnit = u;
    this.persist();
  }
  setAnimationsEnabled(enabled: boolean) {
    this.animationsEnabled = enabled;
    this.persist();
    if (enabled) {
      startDemoTicker();
    } else {
      stopDemoTicker();
    }
  }
}

export const preferences = new PreferencesState();
