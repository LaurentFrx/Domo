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
  musicFadeSeconds: number;
  musicSmartFades: boolean;
  musicLoudnessLeveling: boolean;
};

const DEFAULTS: Persisted = {
  pvThreshold: 1500,
  hcMinTemp: 45,
  animationsEnabled: true,
  theme: 'light',
  autoTheme: false,
  productionSmoothHalf: 3,
  // Fondu OPT-IN (0 = désactivé) : tant qu'il est à zéro, le graphe Web Audio
  // n'est jamais créé et le chemin audio historique reste inchangé — on
  // n'impose pas un mécanisme non testé sur appareil à toute la maison.
  musicFadeSeconds: 0,
  musicSmartFades: true,
  musicLoudnessLeveling: false
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
  /** Durée du fondu enchaîné du lecteur musique (secondes, 0 = désactivé). */
  musicFadeSeconds = $state(DEFAULTS.musicFadeSeconds);
  /** Fondu calé sur l'analyse de sonie Plex (fin sèche → enchaînement court). */
  musicSmartFades = $state(DEFAULTS.musicSmartFades);
  /** Volume nivelé entre morceaux (gain d'analyse Plex). */
  musicLoudnessLeveling = $state(DEFAULTS.musicLoudnessLeveling);

  hydrate() {
    if (typeof window === 'undefined') return;
    const p = load();
    this.pvThreshold = p.pvThreshold;
    this.hcMinTemp = p.hcMinTemp;
    this.animationsEnabled = p.animationsEnabled;
    this.theme = p.theme;
    this.autoTheme = p.autoTheme;
    this.productionSmoothHalf = p.productionSmoothHalf;
    this.musicFadeSeconds = p.musicFadeSeconds;
    this.musicSmartFades = p.musicSmartFades;
    this.musicLoudnessLeveling = p.musicLoudnessLeveling;
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
      productionSmoothHalf: this.productionSmoothHalf,
      musicFadeSeconds: this.musicFadeSeconds,
      musicSmartFades: this.musicSmartFades,
      musicLoudnessLeveling: this.musicLoudnessLeveling
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
  setMusicFadeSeconds(v: number) {
    this.musicFadeSeconds = Math.max(0, Math.min(12, Math.round(v)));
    this.persist();
  }
  setMusicSmartFades(enabled: boolean) {
    this.musicSmartFades = enabled;
    this.persist();
  }
  setMusicLoudnessLeveling(enabled: boolean) {
    this.musicLoudnessLeveling = enabled;
    this.persist();
  }
}

export const preferences = new PreferencesState();
