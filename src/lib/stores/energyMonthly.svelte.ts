/**
 * Ventilation mensuelle énergie/économies — polling de /api/energy/monthly
 * (lecture de la base domo-recorder, agrégée par mois sur l'année courante).
 *
 * Alimente le « Tableau mensuel » + les KPI « Impact ce mois » de la page
 * Énergie. Donnée à évolution LENTE (seul le mois courant grossit, au rythme du
 * recorder) → poll généreux à 5 min. Visibility-aware (calqué sur savings) :
 * pause en arrière-plan + refetch immédiat au retour au premier plan. 503 →
 * connected false propre (le tableau affiche « — »).
 */

const POLL_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

export interface MonthAgg {
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  savings_eur: number;
}

export interface MonthlyPayload {
  year: number;
  months: MonthAgg[]; // 12 entrées, index 0 = janvier
  min_year?: number; // première année avec des données (borne du sélecteur)
}

function zeroMonth(): MonthAgg {
  return {
    production_kwh: 0,
    autoconso_kwh: 0,
    surplus_kwh: 0,
    import_kwh: 0,
    savings_eur: 0
  };
}

function emptyMonths(): MonthAgg[] {
  return Array.from({ length: 12 }, zeroMonth);
}

/** Garde : nombre fini ≥ 0, sinon 0 (jamais NaN/undefined/négatif dans l'UI). */
function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0;
}

function normMonth(m: Partial<MonthAgg> | undefined): MonthAgg {
  return {
    production_kwh: num(m?.production_kwh),
    autoconso_kwh: num(m?.autoconso_kwh),
    surplus_kwh: num(m?.surplus_kwh),
    import_kwh: num(m?.import_kwh),
    savings_eur: num(m?.savings_eur)
  };
}

/** Normalise vers exactement 12 mois (comble/tronque si la réponse déraille). */
function normMonths(arr: unknown): MonthAgg[] {
  const src = Array.isArray(arr) ? arr : [];
  return Array.from({ length: 12 }, (_, i) => normMonth(src[i] as Partial<MonthAgg> | undefined));
}

class EnergyMonthlyState {
  #months = $state<MonthAgg[]>(emptyMonths());
  #year = $state<number>(new Date().getFullYear());
  #minYear = $state<number>(new Date().getFullYear());

  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);

  #intervalId: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  get months(): MonthAgg[] {
    return this.#months;
  }
  get year(): number {
    return this.#year;
  }
  /** Première année disposant de données (borne basse du sélecteur d'année). */
  get minYear(): number {
    return this.#minYear;
  }

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    if (this.#visibilityHandler !== null) return; // idempotent (layout + page)
    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.#startInterval();
      } else {
        this.#stopInterval();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    // UN fetch au montage dans tous les cas → tableau mensuel prêt même si l'onglet
    // est hydraté masqué ; l'interval ne démarre que si visible (cf. savings).
    this.poll();
    if (document.visibilityState === 'visible') this.#startInterval();
  }

  disconnect() {
    this.#stopInterval();
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #startInterval() {
    if (this.#intervalId !== null) return;
    this.#intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  #stopInterval() {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  /**
   * Fetch ponctuel d'une année donnée (années PASSÉES, figées) → 12 mois
   * normalisés. N'altère pas l'état de polling de l'année courante (qui alimente
   * les KPI « Impact ce mois »). Échec/503 → 12 mois à zéro (le tableau affiche
   * « — »). La page met ce résultat en cache : une année passée ne bouge plus.
   */
  async fetchYear(year: number): Promise<MonthAgg[]> {
    try {
      const res = await fetch(`/api/energy/monthly?year=${year}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) return emptyMonths();
      const p = (await res.json()) as Partial<MonthlyPayload>;
      return normMonths(p.months);
    } catch {
      return emptyMonths();
    }
  }

  async poll() {
    this.status = 'polling';
    try {
      const res = await fetch('/api/energy/monthly', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 503) {
        this.connected = false;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.lastError = body.error ?? 'service unavailable';
        this.status = /configur/i.test(this.lastError) ? 'unconfigured' : 'error';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as Partial<MonthlyPayload>;
      this.#months = normMonths(p.months);
      this.#year = typeof p.year === 'number' ? p.year : new Date().getFullYear();
      this.#minYear = typeof p.min_year === 'number' ? p.min_year : this.#year;
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      this.connected = false;
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const energyMonthly = new EnergyMonthlyState();
