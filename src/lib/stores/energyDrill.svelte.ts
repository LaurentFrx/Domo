/**
 * Navigation à trois niveaux du bilan : ANNÉE → MOIS → JOUR.
 *
 * Un seul état pour les DEUX cartes de la section (le graphe « Saisons » et la
 * répartition Heures Creuses / Pleines) : ouvrir août dans l'une fait descendre
 * l'autre au même endroit — elles racontent la même période, toujours.
 *
 * Le niveau ANNÉE ne refetche rien : il réutilise le store `energyMonthly`, déjà
 * pollé pour les KPI de la page. Les niveaux MOIS et JOUR appellent
 * /api/energy/daily et /api/energy/hourly, et sont mis en CACHE : un mois passé
 * ne bouge plus, et l'aller-retour jour → mois → jour doit être instantané.
 */
import type { MonthAgg } from './energyMonthly.svelte';

/** Une tranche de temps, quel que soit le niveau (mois, jour, heure). */
export interface Bucket {
  label: string;
  /** Clé du niveau inférieur ('2026-08', '2026-08-14'), null au dernier niveau. */
  key: string | null;
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  import_hc_kwh: number;
  import_hp_kwh: number;
  savings_eur: number;
  import_split_source: 'curve' | 'meter' | 'local' | 'enedis' | null;
  /** Aucune donnée pour cette tranche : piste vide, jamais un zéro trompeur. */
  empty: boolean;
  /** Autoconso reconstruite des € (pré-recorder) → tilde côté UI. */
  autoconso_estimated: boolean;
}

export type DrillLevel = 'year' | 'month' | 'day';

const TIMEOUT_MS = 15_000;

function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0;
}

function normSource(s: unknown): Bucket['import_split_source'] {
  return s === 'curve' || s === 'meter' || s === 'local' || s === 'enedis' ? s : null;
}

/** Normalise un bucket venu du réseau (même exigence que le store mensuel). */
function normBucket(b: Partial<Bucket> | undefined, fallbackLabel: string): Bucket {
  return {
    label: typeof b?.label === 'string' && b.label ? b.label : fallbackLabel,
    key: typeof b?.key === 'string' ? b.key : null,
    production_kwh: num(b?.production_kwh),
    autoconso_kwh: num(b?.autoconso_kwh),
    surplus_kwh: num(b?.surplus_kwh),
    import_kwh: num(b?.import_kwh),
    import_hc_kwh: num(b?.import_hc_kwh),
    import_hp_kwh: num(b?.import_hp_kwh),
    savings_eur: num(b?.savings_eur),
    import_split_source: normSource(b?.import_split_source),
    empty: b?.empty === true,
    autoconso_estimated: b?.autoconso_estimated === true
  };
}

/** Les 12 mois du store mensuel, vus comme des buckets navigables. */
export function monthsToBuckets(
  months: MonthAgg[],
  labels: string[],
  year: number,
  isCurrentYear: boolean,
  currentMonthIdx: number
): Bucket[] {
  return months.map((m, i) => {
    const total = (m.autoconso_kwh || 0) + (m.import_kwh || 0);
    return {
      label: labels[i] ?? String(i + 1),
      key: `${year}-${String(i + 1).padStart(2, '0')}`,
      production_kwh: m.production_kwh,
      autoconso_kwh: m.autoconso_kwh,
      surplus_kwh: m.surplus_kwh,
      import_kwh: m.import_kwh,
      import_hc_kwh: m.import_hc_kwh,
      import_hp_kwh: m.import_hp_kwh,
      savings_eur: m.savings_eur,
      import_split_source: m.import_split_source,
      empty: (isCurrentYear && i > currentMonthIdx) || total < 0.5,
      autoconso_estimated: m.autoconso_estimated
    };
  });
}

const MOIS_LONG = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre'
];

/** '2026-08' → 'Août 2026' ; '2026-08-14' → '14 août 2026'. */
export function humanKey(key: string): string {
  const [y, m, d] = key.split('-');
  const mi = Number(m) - 1;
  const nom = MOIS_LONG[mi] ?? m;
  if (!d) return `${nom} ${y}`;
  return `${Number(d)} ${nom.toLowerCase()} ${y}`;
}

class EnergyDrillState {
  /** '2026-08' quand on est descendu dans un mois. */
  month = $state<string | null>(null);
  /** '2026-08-14' quand on est descendu dans un jour. */
  day = $state<string | null>(null);
  /** Buckets du niveau courant (vide au niveau année : la page fournit les mois). */
  buckets = $state<Bucket[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Niveau jour : la production solaire est-elle connue ce jour-là ? */
  hasPv = $state(true);
  /** Niveau jour : la courbe ½h de ce jour a-t-elle déjà été récupérée ?
   * (le backfill remonte le temps sur plusieurs heures — avant son passage,
   * une journée ancienne est vide sans que rien ne soit cassé). */
  hasCurve = $state(true);

  #cache = new Map<string, Bucket[]>();
  #seq = 0; // anti-course : seule la dernière demande peut écrire

  get level(): DrillLevel {
    if (this.day) return 'day';
    if (this.month) return 'month';
    return 'year';
  }

  /** Descend d'un niveau. `key` = '2026-08' (mois) ou '2026-08-14' (jour). */
  async open(key: string | null): Promise<void> {
    if (!key) return;
    const isDay = key.length === 10;
    if (isDay) this.day = key;
    else {
      this.month = key;
      this.day = null;
    }
    await this.#load(key, isDay);
  }

  /** Remonte d'un niveau (jour → mois → année). */
  back(): void {
    if (this.day) {
      const m = this.month;
      this.day = null;
      this.error = null;
      if (m) void this.#load(m, false);
      return;
    }
    this.month = null;
    this.buckets = [];
    this.error = null;
  }

  /** Retour direct à l'année (fil d'Ariane, ou changement d'année). */
  reset(): void {
    this.month = null;
    this.day = null;
    this.buckets = [];
    this.error = null;
    this.loading = false;
  }

  async #load(key: string, isDay: boolean): Promise<void> {
    const cached = this.#cache.get(key);
    if (cached) {
      this.buckets = cached;
      this.error = null;
      this.loading = false;
      return;
    }
    const seq = ++this.#seq;
    this.loading = true;
    this.error = null;
    try {
      const url = isDay
        ? `/api/energy/hourly?date=${encodeURIComponent(key)}`
        : `/api/energy/daily?month=${encodeURIComponent(key)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as {
        days?: Partial<Bucket>[];
        hours?: Partial<Bucket>[];
        has_pv?: boolean;
        has_curve?: boolean;
      };
      if (seq !== this.#seq) return; // une demande plus récente a pris la main
      const raw = (isDay ? p.hours : p.days) ?? [];
      const list = raw.map((b, i) => normBucket(b, String(i + 1)));
      // Un jour du passé ne bouge plus ; le jour courant et le mois courant, si —
      // on ne met en cache que ce qui est figé.
      const today = new Date().toISOString().slice(0, 10);
      const complete = !isDay || p.has_curve !== false;
      if (complete && key < today.slice(0, key.length)) this.#cache.set(key, list);
      this.buckets = list;
      this.hasPv = isDay ? p.has_pv !== false : true;
      this.hasCurve = isDay ? p.has_curve !== false : true;
    } catch (e) {
      if (seq !== this.#seq) return;
      this.buckets = [];
      this.error = e instanceof Error ? e.message : 'erreur inconnue';
    } finally {
      if (seq === this.#seq) this.loading = false;
    }
  }
}

export const energyDrill = new EnergyDrillState();
