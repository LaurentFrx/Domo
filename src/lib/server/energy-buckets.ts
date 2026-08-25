/**
 * Socle commun des vues « bilan » de la page Énergie : un BUCKET est une tranche
 * de temps (un mois, un jour, une heure) portant toujours les mêmes grandeurs.
 * Les trois niveaux du drill-down (année → mois → jour) parlent donc la même
 * langue, et les cartes du client n'ont qu'un seul type à connaître.
 *
 * Fuseau : la base stocke des epochs UTC (pv_samples, enedis_curve) et des dates
 * civiles Paris (enedis_daily, savings_daily). Les bornes sont donc TOUJOURS
 * calculées en Paris ici, jamais laissées à SQLite (`localtime` suivrait le TZ du
 * process — le serveur tourne en UTC).
 */
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

/** Une tranche de temps du bilan, quelle que soit sa durée. */
export interface Bucket {
  /** Étiquette d'axe, courte (« Jan », « 14 », « 08 h »). */
  label: string;
  /** Clé du niveau inférieur, ou null si on est au dernier niveau (heure) :
   * '2026-08' pour un mois, '2026-08-14' pour un jour. */
  key: string | null;
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  import_hc_kwh: number;
  import_hp_kwh: number;
  savings_eur: number;
  /** Provenance de la ventilation HC/HP, même vocabulaire que la vue mensuelle :
   * 'curve' = mesurée (courbe ½h), null = inconnue à ce niveau. */
  import_split_source: 'curve' | null;
  /** Vrai quand aucune donnée n'existe pour cette tranche (≠ une vraie valeur
   * nulle) : l'UI montre une piste vide plutôt qu'un zéro trompeur. */
  empty: boolean;
}

export function emptyBucket(label: string, key: string | null = null): Bucket {
  return {
    label,
    key,
    production_kwh: 0,
    autoconso_kwh: 0,
    surplus_kwh: 0,
    import_kwh: 0,
    import_hc_kwh: 0,
    import_hp_kwh: 0,
    savings_eur: 0,
    import_split_source: null,
    empty: true
  };
}

/** Ouvre history.db en lecture (readonly d'abord, repli rw — cf. /api/savings) ;
 * null si la base est absente/illisible. L'appelant renvoie alors un 503 propre. */
export function openDb(): Database.Database | null {
  const path = env.RECORDER_DB_PATH;
  if (!path) return null;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    try {
      db = new Database(path, { readonly: false, fileMustExist: true });
    } catch {
      return null;
    }
  }
  db.pragma('busy_timeout = 5000');
  return db;
}

export function hasTable(db: Database.Database, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

/** Décalage Paris↔UTC (secondes) à un instant donné : +7200 l'été, +3600 l'hiver.
 * Sert à convertir un instant civil Paris en epoch sans dépendre du TZ serveur. */
export function parisOffsetS(at: Date): number {
  const s = at.toLocaleString('en-US', { timeZone: 'Europe/Paris', hour12: false });
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC', hour12: false }));
  return Math.round((new Date(s).getTime() - asUtc.getTime()) / 1000);
}

/** Epoch UTC du début du jour civil Paris `YYYY-MM-DD`. Le décalage est celui qui
 * s'applique À CE JOUR-LÀ (midi comme sonde : jamais dans l'heure escamotée). */
export function parisDayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0) / 1000;
  const off = parisOffsetS(new Date(noonUtc * 1000));
  return Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0) / 1000 - off;
}

/** Nombre de jours d'un mois `YYYY-MM`. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Intègre une série de puissances (trapèze, gap ≤ 600 s) sur des bornes données.
 * C'est le même calcul que le recorder et que /api/energy/monthly — refait ici
 * pour des tranches fines, avec les bornes passées en epoch (pas de strftime, qui
 * ne saurait pas où couper les jours en heure locale).
 *
 * `edges` = bornes croissantes (n+1 valeurs pour n tranches).
 * Retourne un tableau de n sommes en kWh.
 */
export function integrateByEdges(
  db: Database.Database,
  column: string,
  edges: number[],
  clampPositive = false
): number[] {
  const out = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
  if (edges.length < 2) return out;
  const expr = clampPositive ? `MAX(0.0, COALESCE(${column},0))` : `COALESCE(${column},0)`;
  let rows: { ts: number; dt: number; avg: number }[];
  try {
    rows = db
      .prepare(
        'SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS dt,' +
          ` (${expr} + LAG(${expr}) OVER (ORDER BY ts))/2.0 AS avg` +
          ' FROM pv_samples WHERE ts >= ? AND ts <= ? ORDER BY ts'
      )
      .all(edges[0] - 600, edges[edges.length - 1] + 600) as {
      ts: number;
      dt: number;
      avg: number;
    }[];
  } catch {
    return out; // colonne absente (base antérieure)
  }
  // Curseur glissant : les lignes arrivent triées par ts et les bornes sont
  // croissantes, donc on avance dans les tranches sans jamais les rebalayer —
  // O(lignes + tranches) au lieu de O(lignes × tranches) (2,7 M d'itérations
  // pour un mois d'échantillons à 30 s, sinon).
  let cur = 0;
  for (const r of rows) {
    if (!r.dt || r.dt <= 0 || r.dt > 600 || !Number.isFinite(r.avg)) continue;
    // L'échantillon couvre [ts − dt, ts]. Il chevauche en général UNE tranche,
    // deux quand il enjambe une frontière — le calcul reste juste au-delà si le
    // recorder a manqué des ticks.
    const a = r.ts - r.dt;
    const b = r.ts;
    while (cur < out.length && edges[cur + 1] <= a) cur++;
    for (let i = cur; i < out.length && edges[i] < b; i++) {
      const lo = Math.max(a, edges[i]);
      const hi = Math.min(b, edges[i + 1]);
      if (hi > lo) out[i] += (r.avg * (hi - lo)) / 3600 / 1000;
    }
  }
  return out;
}
