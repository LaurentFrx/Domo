/**
 * Historique de l'ancien contrat EDF (Tarif Bleu HP/HC, clos en octobre 2024),
 * importé des exports de l'espace client par `ops/import-edf-history.py` dans
 * trois tables BRUTES de history.db :
 *  · edf_index : registres Linky Heures Pleines / Creuses cumulés, « transmis
 *    par le distributeur » — des MESURES. L'index du jour D est lu en début de
 *    journée : conso(D) = index(D+1) − index(D) (vérifié sur 215 jours contre
 *    l'export quotidien). Un relevé par mois (le 28) jusqu'en janvier 2024, puis
 *    un par jour à partir du 09/03/2024 ;
 *  · edf_monthly : consommation par mois civil, 'reelle' ou 'estimee' selon
 *    EDF — la plupart des mois anciens sont des estimations ;
 *  · edf_daily : consommation par jour, gardée pour recoupement seulement
 *    (Enedis couvre déjà toute sa période, sans trou).
 *
 * Rien d'autre n'est stocké : ce qui en découle se calcule ICI, à la lecture.
 * Rang dans la hiérarchie de l'import : enedis_daily > savings_daily > relevés
 * saisis (tariffs.json) > EDF, qui ne sert que là où rien d'autre n'existe. Ces
 * kWh ne sont jamais chiffrés en € : aucun tarif connu ne s'y applique de façon
 * vérifiable.
 *
 * Tables absentes (base d'avant l'import) → null : les routes gardent leur
 * comportement d'avant, à l'identique.
 */
import type Database from 'better-sqlite3';
import { daysInMonth, hasTable } from '$lib/server/energy-buckets';

/** Ventilation Creuses / Pleines tirée des registres Linky. */
export interface IndexSplit {
  /** Part Heures Creuses, dans [0, 1]. */
  hcShare: number;
  /** `index` : chaque jour du mois est encadré par deux relevés quotidiens —
   * la répartition est MESURÉE. `index_est` : au moins 40 % du mois couvert,
   * mais une partie par des intervalles plus longs, répartis au prorata des
   * jours — une ESTIMATION. */
  source: 'index' | 'index_est';
}

export interface EdfHistory {
  /** 'YYYY-MM' → volume du mois selon EDF, et s'il s'agit d'une estimation. */
  monthly: Map<string, { kwh: number; estimated: boolean }>;
  /** 'YYYY-MM' → ventilation du mois d'après les index. */
  monthSplit: Map<string, IndexSplit>;
  /** 'YYYY-MM-DD' → part HC du jour, pour les seuls jours encadrés par deux
   * relevés (celui du jour et celui du lendemain). */
  dayHcShare: Map<string, number>;
  /** Premier mois connu d'edf_monthly, null si aucun. */
  firstMonth: string | null;
}

export interface IndexRow {
  date: string;
  hp_kwh: number;
  hc_kwh: number;
}

/** Même seuil que la courbe ½h (cf. /api/energy/monthly) : sous 40 % du mois
 * couvert, une répartition ne dit plus rien du mois. */
const INDEX_MIN_COVERAGE = 0.4;

const DAY_MS = 86_400_000;

function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Répartit chaque intervalle entre deux relevés consécutifs [d_i, d_i+1)
 * UNIFORMÉMENT sur ses jours, puis somme par mois civil. Un intervalle de 61 jours
 * (relevé du 28 manquant) nourrit ainsi les deux mois qu'il enjambe, au prorata
 * de leurs jours. Fonction pure : c'est elle que les tests exercent.
 */
export function indexSplits(rows: IndexRow[]): {
  monthSplit: Map<string, IndexSplit>;
  dayHcShare: Map<string, number>;
} {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const acc = new Map<string, { hp: number; hc: number; covered: number; daily: number }>();
  const dayHcShare = new Map<string, number>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const n = Math.round((dayMs(b.date) - dayMs(a.date)) / DAY_MS);
    const dhp = b.hp_kwh - a.hp_kwh;
    const dhc = b.hc_kwh - a.hc_kwh;
    // L'import refuse un index qui recule ; défense en profondeur quand même.
    if (n <= 0 || dhp < 0 || dhc < 0) continue;
    if (n === 1 && dhp + dhc > 0) dayHcShare.set(a.date, dhc / (dhp + dhc));
    const start = dayMs(a.date);
    for (let k = 0; k < n; k++) {
      const ym = new Date(start + k * DAY_MS).toISOString().slice(0, 7);
      const m = acc.get(ym) ?? { hp: 0, hc: 0, covered: 0, daily: 0 };
      m.hp += dhp / n;
      m.hc += dhc / n;
      m.covered += 1;
      if (n === 1) m.daily += 1;
      acc.set(ym, m);
    }
  }
  const monthSplit = new Map<string, IndexSplit>();
  for (const [ym, m] of acc) {
    const tot = m.hp + m.hc;
    if (tot <= 0) continue;
    const nDays = daysInMonth(ym);
    // Mars 2024 : 23 jours en relevés quotidiens + 8 dans l'intervalle de 41 j →
    // pas « tout en quotidien », mais couvert à 100 % : c'est une estimation.
    const source =
      m.daily >= nDays ? 'index' : m.covered / nDays >= INDEX_MIN_COVERAGE ? 'index_est' : null;
    if (source) monthSplit.set(ym, { hcShare: m.hc / tot, source });
  }
  return { monthSplit, dayHcShare };
}

let memo: { key: string; value: EdfHistory } | null = null;

/**
 * Lecture mémoïsée : ces tables ne bougent plus une fois importées, mais un
 * retour arrière (DROP) ou un second import doit se voir sans redémarrer Domo —
 * la clé porte donc le chemin de la base et le décompte des lignes (≈ 300, coût
 * négligeable). null quand aucune table EDF n'existe.
 */
export function edfHistory(db: Database.Database): EdfHistory | null {
  const hasIndex = hasTable(db, 'edf_index');
  const hasMonthly = hasTable(db, 'edf_monthly');
  if (!hasIndex && !hasMonthly) return null;
  const count = (sql: string) => (db.prepare(sql).get() as { k: string }).k;
  const key = [
    db.name,
    hasIndex ? count("SELECT COUNT(*) || ':' || COALESCE(MAX(date), '') AS k FROM edf_index") : '-',
    hasMonthly
      ? count("SELECT COUNT(*) || ':' || COALESCE(MAX(month), '') AS k FROM edf_monthly")
      : '-'
  ].join('|');
  if (memo && memo.key === key) return memo.value;

  const monthly = new Map<string, { kwh: number; estimated: boolean }>();
  if (hasMonthly) {
    for (const r of db.prepare('SELECT month, kwh, nature FROM edf_monthly').all() as {
      month: string;
      kwh: number;
      nature: string;
    }[]) {
      if (Number.isFinite(r.kwh) && r.kwh >= 0)
        monthly.set(r.month, { kwh: r.kwh, estimated: r.nature !== 'reelle' });
    }
  }
  const { monthSplit, dayHcShare } = hasIndex
    ? indexSplits(db.prepare('SELECT date, hp_kwh, hc_kwh FROM edf_index').all() as IndexRow[])
    : { monthSplit: new Map<string, IndexSplit>(), dayHcShare: new Map<string, number>() };
  const firstMonth = [...monthly.keys()].sort()[0] ?? null;

  const value: EdfHistory = { monthly, monthSplit, dayHcShare, firstMonth };
  memo = { key, value };
  return value;
}
