/**
 * Tarifs électricité — logique HP/HC pure, côté serveur.
 *
 * Source : `data/tariffs.json` (gitignored, racine projet). Modèle à `regimes`
 * datés : on choisit le régime en vigueur à l'instant `t` (le dernier dont
 * `from` ≤ date locale Paris), puis on classe HP/HC selon ses `hc_windows`.
 *
 * Tout est calé sur l'heure LOCALE Europe/Paris et DST-aware via `Intl`
 * (timeZone) — jamais d'offset codé en dur. Les fenêtres HC sont wrap-safe
 * (une fenêtre `["22:00","06:00"]` qui enjambe minuit est gérée).
 *
 * Tests conceptuels (régime 00:06→08:06) :
 *   00:05 → HP · 00:06 → HC · 08:05 → HC · 08:06 → HP
 *   et le classement reste correct au passage heure été/hiver (Intl gère l'offset).
 *
 * Server-only (dossier `$lib/server`) : jamais embarqué dans le bundle client.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface TariffRegime {
  /** Date d'entrée en vigueur 'YYYY-MM-DD' (locale Paris). */
  from: string;
  hp_eur_kwh: number;
  hc_eur_kwh: number;
  /** Fenêtres HC `[["HH:MM","HH:MM"]]` (locale Paris, fin exclue, wrap-safe). */
  hc_windows: [string, string][];
}

/**
 * Économies/énergie déjà acquises AVANT que le recorder ne commence à accumuler
 * (import depuis l'ancien suivi HA). Ancrées à `anchor` (jour de bascule) : la
 * baseline du mois ne s'applique QUE tant qu'on est dans le mois de l'anchor
 * (ensuite le recorder a un mois complet, elle disparaît), idem pour l'année ;
 * le total s'applique toujours. Pas de baseline « jour » (le recorder est la
 * source live du jour). Convention : baseline = valeur_vraie − ce_que_le
 * recorder a déjà compté au même instant → l'écart reste constant dans le temps.
 */
export interface TariffBaseline {
  anchor: string; // 'YYYY-MM-DD'
  month_eur: number;
  month_kwh: number;
  year_eur: number;
  year_kwh: number;
  total_eur: number;
  total_kwh: number;
}

export interface TariffConfig {
  tz: string;
  baseline: TariffBaseline;
  regimes: TariffRegime[];
}

export type TariffPeriod = 'HP' | 'HC';

export interface PeriodBaseline {
  eur: number;
  kwh: number;
}

const ZERO_BASELINE: TariffBaseline = {
  anchor: '',
  month_eur: 0,
  month_kwh: 0,
  year_eur: 0,
  year_kwh: 0,
  total_eur: 0,
  total_kwh: 0
};

const TARIFFS_FILE = path.resolve(process.cwd(), 'data', 'tariffs.json');

// Défaut embarqué : si `data/tariffs.json` est absent/illisible (déploiement
// neuf, fichier gitignored pas encore créé), on reste fonctionnel.
const DEFAULT_CONFIG: TariffConfig = {
  tz: 'Europe/Paris',
  baseline: ZERO_BASELINE,
  regimes: [
    { from: '2024-01-01', hp_eur_kwh: 0.2318, hc_eur_kwh: 0.1812, hc_windows: [['00:06', '08:06']] }
  ]
};

// Cache invalidé sur le mtime du fichier : édition à chaud prise en compte au
// prochain appel sans relire à chaque requête.
let cache: { mtimeMs: number; cfg: TariffConfig } | null = null;

function normalize(raw: unknown): TariffConfig {
  const o = (raw ?? {}) as Partial<TariffConfig> & {
    baseline_eur?: number;
    baseline_kwh?: number;
  };
  const regimes =
    Array.isArray(o.regimes) && o.regimes.length > 0 ? o.regimes : DEFAULT_CONFIG.regimes;
  const b = (o.baseline ?? {}) as Partial<TariffBaseline>;
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const baseline: TariffBaseline = {
    anchor: typeof b.anchor === 'string' ? b.anchor : '',
    month_eur: n(b.month_eur),
    month_kwh: n(b.month_kwh),
    year_eur: n(b.year_eur),
    year_kwh: n(b.year_kwh),
    // Rétro-compat : un ancien `baseline_eur`/`baseline_kwh` à plat = total.
    total_eur: n(b.total_eur ?? o.baseline_eur),
    total_kwh: n(b.total_kwh ?? o.baseline_kwh)
  };
  return { tz: o.tz ?? 'Europe/Paris', baseline, regimes };
}

function loadConfig(): TariffConfig {
  try {
    const { mtimeMs } = statSync(TARIFFS_FILE);
    if (cache && cache.mtimeMs === mtimeMs) return cache.cfg;
    const cfg = normalize(JSON.parse(readFileSync(TARIFFS_FILE, 'utf-8')));
    cache = { mtimeMs, cfg };
    return cfg;
  } catch {
    return DEFAULT_CONFIG; // fichier absent/illisible → défaut, jamais de crash
  }
}

// Formatteurs Intl figés (coûteux à créer) — locale Paris, DST-aware.
const HM_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23' // 00:00 → "00" (pas "24")
});
const YMD_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}); // en-CA → 'YYYY-MM-DD'

/** Minutes depuis minuit en heure locale Paris (0..1439). */
function parisMinutes(t: Date): number {
  const parts = HM_FMT.formatToParts(t);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

/** Date locale Paris 'YYYY-MM-DD'. */
export function parisDate(t: Date): string {
  return YMD_FMT.format(t);
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Régime tarifaire en vigueur à l'instant `t` (dernier `from` ≤ date Paris). */
export function regimeAt(t: Date): TariffRegime {
  const cfg = loadConfig();
  const day = parisDate(t);
  let chosen: TariffRegime | null = null;
  for (const r of [...cfg.regimes].sort((a, b) => a.from.localeCompare(b.from))) {
    if (r.from <= day) chosen = r;
  }
  return chosen ?? cfg.regimes[0] ?? DEFAULT_CONFIG.regimes[0];
}

/** Vrai si `t` tombe dans une fenêtre Heures Creuses (locale Paris, wrap-safe). */
export function isHC(t: Date): boolean {
  const r = regimeAt(t);
  const m = parisMinutes(t);
  for (const [a, b] of r.hc_windows ?? []) {
    const start = hhmmToMin(a);
    const end = hhmmToMin(b);
    if (start <= end) {
      if (m >= start && m < end) return true; // fenêtre intra-journée, fin exclue
    } else if (m >= start || m < end) {
      return true; // fenêtre enjambant minuit
    }
  }
  return false;
}

/** Prix (€/kWh) + période applicable à l'instant `t`. */
export function priceAt(t: Date): { eur_kwh: number; period: TariffPeriod } {
  const r = regimeAt(t);
  return isHC(t)
    ? { eur_kwh: r.hc_eur_kwh, period: 'HC' }
    : { eur_kwh: r.hp_eur_kwh, period: 'HP' };
}

/**
 * Prochaine bascule HP/HC à partir de `t` (heure locale Paris, wrap-safe).
 * Les bornes de bascule = débuts ET fins des fenêtres HC. `inMinutes` est l'écart
 * jusqu'à la prochaine borne ; `period` est le régime EN VIGUEUR APRÈS la bascule.
 * (Pour 1 fenêtre HC unique — config réelle — c'est l'inverse du régime courant.)
 */
export function nextTariffSwitch(t: Date): {
  period: TariffPeriod;
  inMinutes: number;
  atHHMM: string;
} {
  const r = regimeAt(t);
  const m = parisMinutes(t);
  const bounds = new Set<number>();
  for (const [a, b] of r.hc_windows ?? []) {
    bounds.add(hhmmToMin(a));
    bounds.add(hhmmToMin(b));
  }
  const sorted = [...bounds].sort((x, y) => x - y);
  if (sorted.length === 0) {
    return { period: isHC(t) ? 'HC' : 'HP', inMinutes: 0, atHHMM: '' };
  }
  let next = sorted.find((x) => x > m);
  const inMinutes = next === undefined ? 1440 - m + sorted[0] : next - m;
  if (next === undefined) next = sorted[0];
  const hh = Math.floor(next / 60);
  const mm = next % 60;
  const atHHMM = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  // Après une borne, le régime s'inverse (cas 1 fenêtre HC = config réelle).
  return { period: isHC(t) ? 'HP' : 'HC', inMinutes, atHHMM };
}

/**
 * Baselines APPLICABLES à l'instant `t`, par période. Le total s'applique
 * toujours ; le mois/l'année seulement si `t` est encore dans le mois/l'année
 * de l'anchor (au-delà, le recorder couvre la période entière → baseline = 0,
 * sinon double comptage). Pas de baseline « jour ».
 */
export function applicableBaseline(t: Date): {
  month: PeriodBaseline;
  year: PeriodBaseline;
  total: PeriodBaseline;
} {
  const b = loadConfig().baseline;
  const day = parisDate(t);
  const sameMonth = b.anchor !== '' && day.slice(0, 7) === b.anchor.slice(0, 7);
  const sameYear = b.anchor !== '' && day.slice(0, 4) === b.anchor.slice(0, 4);
  return {
    month: { eur: sameMonth ? b.month_eur : 0, kwh: sameMonth ? b.month_kwh : 0 },
    year: { eur: sameYear ? b.year_eur : 0, kwh: sameYear ? b.year_kwh : 0 },
    total: { eur: b.total_eur, kwh: b.total_kwh }
  };
}
