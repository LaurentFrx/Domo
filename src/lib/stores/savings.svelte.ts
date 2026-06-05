/**
 * Économies d'autoconsommation — polling de /api/savings (lecture de la base
 * domo-recorder, agrégée jour/mois/année/total).
 *
 * La donnée ne bouge qu'au rythme du recorder (tick 2 min) → un poll à 60 s
 * suffit largement. Visibility-aware (calqué sur anker/apsystems) : pause en
 * arrière-plan + refetch immédiat au retour au premier plan. 503 → connected
 * false propre (la carte affiche « — »).
 */

const POLL_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 15_000;

export interface SavingsPeriod {
  eur: number;
  eur_hp: number;
  eur_hc: number;
  kwh: number;
  kwh_hp: number;
  kwh_hc: number;
}

export interface SavingsToday extends SavingsPeriod {
  /** Taux d'économie instantané (€/h), 0 si recorder périmé. */
  rate_eur_h: number;
  /** Taux de couverture solaire du jour (0-100). */
  coverage_pct: number;
}

export interface SavingsPayload {
  today: SavingsToday;
  month: SavingsPeriod;
  year: SavingsPeriod;
  total: SavingsPeriod;
}

const EMPTY_PERIOD: SavingsPeriod = { eur: 0, eur_hp: 0, eur_hc: 0, kwh: 0, kwh_hp: 0, kwh_hc: 0 };
const EMPTY: SavingsPayload = {
  today: { ...EMPTY_PERIOD, rate_eur_h: 0, coverage_pct: 0 },
  month: { ...EMPTY_PERIOD },
  year: { ...EMPTY_PERIOD },
  total: { ...EMPTY_PERIOD }
};

/** Garde : nombre fini, sinon 0 (jamais NaN/undefined dans l'UI). */
function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function normPeriod(p: Partial<SavingsPeriod> | undefined): SavingsPeriod {
  return {
    eur: num(p?.eur),
    eur_hp: num(p?.eur_hp),
    eur_hc: num(p?.eur_hc),
    kwh: num(p?.kwh),
    kwh_hp: num(p?.kwh_hp),
    kwh_hc: num(p?.kwh_hc)
  };
}

class SavingsState {
  #snap = $state<SavingsPayload>(EMPTY);

  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);

  #intervalId: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  // ─── Getters exposés au front ─────────────────────────────────────────
  get today(): SavingsToday {
    return this.#snap.today;
  }
  get month(): SavingsPeriod {
    return this.#snap.month;
  }
  get year(): SavingsPeriod {
    return this.#snap.year;
  }
  get total(): SavingsPeriod {
    return this.#snap.total;
  }

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    if (this.#visibilityHandler !== null) return; // idempotent (layout + page)
    // Arrière-plan → suspend ; retour au premier plan → refetch immédiat.
    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.#startInterval();
      } else {
        this.#stopInterval();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    // Ne démarrer le polling QUE si l'onglet est visible au montage : si l'app
    // est hydratée en arrière-plan (PWA relancée masquée, onglet ouvert en fond),
    // on attend le 1er passage visible via le handler — sinon un interval de fond
    // tournerait jusqu'au premier focus (contraire à « pause en arrière-plan »).
    if (document.visibilityState === 'visible') {
      this.poll();
      this.#startInterval();
    }
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

  async poll() {
    this.status = 'polling';
    try {
      const res = await fetch('/api/savings', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 503) {
        this.connected = false;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.lastError = body.error ?? 'service unavailable';
        // 503 = config absente (permanent) OU DB momentanément verrouillée/illisible
        // (transitoire). On ne déclare 'unconfigured' que pour la 1re cause.
        this.status = /configur/i.test(this.lastError) ? 'unconfigured' : 'error';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as SavingsPayload;
      this.#snap = {
        today: { ...normPeriod(p.today), rate_eur_h: num(p.today?.rate_eur_h), coverage_pct: num(p.today?.coverage_pct) },
        month: normPeriod(p.month),
        year: normPeriod(p.year),
        total: normPeriod(p.total)
      };
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

export const savings = new SavingsState();
