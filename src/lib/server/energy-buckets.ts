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
import { isHC, parisDate, regimeAt } from '$lib/server/tariffs';

/** D'où vient la ventilation HC/HP d'une tranche, du plus fiable au moins
 * fiable — même vocabulaire à tous les niveaux (année, mois, jour) :
 * `curve` = courbe de charge ½h Enedis (la MESURE) ; `meter` = relevé compteur
 * saisi dans tariffs.json ; `enedis` = total Linky mais répartition estimée du
 * ratio EM-50 ; `local` = total ET répartition estimés. `null` = rien de connu. */
export type SplitSource = 'curve' | 'meter' | 'local' | 'enedis' | null;

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
  /** Provenance de la ventilation HC/HP (cf. SplitSource). */
  import_split_source: SplitSource;
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

/**
 * Taille de bucket d'intégration (s) alignée sur les frontières HC du régime, et
 * son décalage. But : qu'aucun bucket ne CHEVAUCHE une bascule HP/HC — sinon son
 * énergie serait classée en bloc du mauvais côté.
 *
 * Les fenêtres réelles (00:06 → 08:06) tombent à 6 min de l'heure ronde ; comme
 * les décalages Paris↔UTC sont des heures entières, un bucket de 30 min décalé
 * de 360 s cale EXACTEMENT sur les deux bascules, été comme hiver. Si les
 * fenêtres du régime ne partagent pas ce reste (config exotique), on rétrograde
 * à 60 s : toujours exact, juste plus de lignes à agréger.
 */
export function bucketing(t: Date): { sizeS: number; offsetS: number } {
  const wins = regimeAt(t).hc_windows ?? [];
  const bounds = wins.flat();
  const rests = bounds.map((hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return ((h || 0) * 3600 + (m || 0) * 60) % 1800;
  });
  const same = rests.length > 0 && rests.every((r) => r === rests[0]);
  return same ? { sizeS: 1800, offsetS: rests[0] } : { sizeS: 60, offsetS: 0 };
}

/**
 * Import réseau vu par l'EM-50 (`pv_samples.em50_grid_w`, ~30 s), intégré par
 * bucket de `sizeS` secondes décalé de `offsetS` sur [a, b) — trapèze, gap
 * plafonné 600 s, part positive seule (le soutirage). Le bucket n° k couvre
 * [k·sizeS + offsetS, (k+1)·sizeS + offsetS) en epoch UTC. Sert au RATIO HC/HP
 * de repli (cf. localHcShareByDay et la vue mensuelle) — jamais aux kWh eux-mêmes :
 * l'EM-50 sous-compte l'import de ~23 % contre Enedis, il dit la FORME d'une
 * journée, pas son niveau. Tableau vide si la colonne n'existe pas encore.
 */
export function em50ImportByBucket(
  db: Database.Database,
  a: number,
  b: number,
  sizeS: number,
  offsetS: number
): { bucket: number; wh: number }[] {
  try {
    return db
      .prepare(
        'WITH d AS (' +
          ' SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS dt,' +
          '  (MAX(0.0,em50_grid_w) + MAX(0.0,LAG(em50_grid_w) OVER (ORDER BY ts)))/2.0 AS avg_imp' +
          '  FROM pv_samples WHERE em50_grid_w IS NOT NULL AND ts >= ? AND ts < ?' +
          ') SELECT (ts - ?) / ? AS bucket,' +
          ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_imp*dt/3600.0 END),0) AS wh' +
          ' FROM d GROUP BY bucket HAVING wh > 0'
      )
      .all(a, b, offsetS, sizeS) as { bucket: number; wh: number }[];
  } catch {
    return []; // colonne em50_grid_w absente (base pré-EM-50)
  }
}

/**
 * Part Heures Creuses de l'import, par JOUR Paris, dérivée de la mesure locale —
 * le repli des jours SANS courbe Enedis : J et J−1 (Enedis publie le lendemain),
 * ou une panne de la passerelle. Même méthode que la vue mensuelle, à l'échelle
 * du jour : l'heure de chaque bucket suffit à le classer HP/HC via le régime.
 * Le scan est borné aux jours demandés (une poignée en général : les autres ont
 * leur courbe). Retour : 'YYYY-MM-DD' → part HC dans [0,1] ; jour absent = pas
 * de mesure (avant l'EM-50, ou journée sans le moindre soutirage).
 */
export function localHcShareByDay(db: Database.Database, days: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (days.length === 0) return out;
  const wanted = new Set(days);
  const sorted = [...days].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  // Marges de bord : 2 h de part et d'autre (fuseau + changement d'heure) ; le
  // classement par jour se fait ensuite sur la date PARIS du milieu du bucket.
  const a = parisDayStart(first) - 7200;
  const b = parisDayStart(last) + 86400 + 7200;
  const { sizeS, offsetS } = bucketing(new Date(parisDayStart(first) * 1000));
  const hc = new Map<string, number>();
  const hp = new Map<string, number>();
  for (const r of em50ImportByBucket(db, a, b, sizeS, offsetS)) {
    if (!Number.isFinite(r.wh) || r.wh <= 0) continue;
    // Milieu du bucket : à l'abri d'un arrondi de bord dans les deux classements.
    const mid = new Date((r.bucket * sizeS + offsetS + sizeS / 2) * 1000);
    const day = parisDate(mid);
    if (!wanted.has(day)) continue;
    const m = isHC(mid) ? hc : hp;
    m.set(day, (m.get(day) ?? 0) + r.wh);
  }
  for (const day of wanted) {
    const tot = (hc.get(day) ?? 0) + (hp.get(day) ?? 0);
    if (tot > 1) out.set(day, (hc.get(day) ?? 0) / tot); // > 1 Wh : ignore le bruit
  }
  return out;
}
