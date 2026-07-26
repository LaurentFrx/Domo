/**
 * Préférences utilisateur — persistées en localStorage côté client.
 * Mock pour l'instant : pvThreshold et hcMinTemp préparent la connexion
 * future au pilotage Cumulus.
 */

const STORAGE_KEY = 'domo.preferences.v1';

type Theme = 'light' | 'dark';

type Persisted = {
  pvThreshold: number;
  hcMinTemp: number;
  animationsEnabled: boolean;
  theme: Theme;
  autoTheme: boolean;
  productionSmoothHalf: number;
};

const DEFAULTS: Persisted = {
  pvThreshold: 1500,
  hcMinTemp: 45,
  animationsEnabled: true,
  theme: 'light',
  autoTheme: false,
  productionSmoothHalf: 3
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
  animationsEnabled = $state(DEFAULTS.animationsEnabled);
  theme = $state<Theme>(DEFAULTS.theme);
  autoTheme = $state(DEFAULTS.autoTheme);
  /** ½-fenêtre de lissage (échantillons ~2 min) de la courbe de production. */
  productionSmoothHalf = $state(DEFAULTS.productionSmoothHalf);

  hydrate() {
    if (typeof window === 'undefined') return;
    const p = load();
    this.pvThreshold = p.pvThreshold;
    this.hcMinTemp = p.hcMinTemp;
    this.animationsEnabled = p.animationsEnabled;
    this.theme = p.theme;
    this.autoTheme = p.autoTheme;
    this.productionSmoothHalf = p.productionSmoothHalf;
    this.applyTheme();
  }

  persist() {
    if (typeof window === 'undefined') return;
    const snap: Persisted = {
      pvThreshold: this.pvThreshold,
      hcMinTemp: this.hcMinTemp,
      animationsEnabled: this.animationsEnabled,
      theme: this.theme,
      autoTheme: this.autoTheme,
      productionSmoothHalf: this.productionSmoothHalf
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // localStorage indisponible (mode privé) : on accepte la perte.
    }
  }

  private applyTheme() {
    if (typeof document === 'undefined') return;
    const effective = this.autoTheme ? this.timeBasedTheme() : this.theme;
    if (effective === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  private timeBasedTheme(): Theme {
    const h = new Date().getHours();
    return h >= 7 && h < 19 ? 'light' : 'dark';
  }

  setPvThreshold(v: number) {
    this.pvThreshold = v;
    this.persist();
  }
  setHcMinTemp(v: number) {
    this.hcMinTemp = v;
    this.persist();
  }
  setAnimationsEnabled(enabled: boolean) {
    this.animationsEnabled = enabled;
    this.persist();
    // (Ce réglage pilotait aussi le générateur de données de démonstration —
    // une préférence de confort visuel commandait la fabrication de fausses
    // mesures. Générateur supprimé.)
  }
  setTheme(theme: Theme) {
    this.theme = theme;
    this.autoTheme = false;
    this.persist();
    this.applyTheme();
  }
  setAutoTheme(enabled: boolean) {
    this.autoTheme = enabled;
    this.persist();
    this.applyTheme();
  }
  setProductionSmoothHalf(v: number) {
    this.productionSmoothHalf = v;
    this.persist();
  }
}

export const preferences = new PreferencesState();
