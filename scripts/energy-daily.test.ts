/**
 * Le bilan de la page Énergie : les JOURS d'un mois (/api/energy/daily) et leur
 * ventilation Heures Creuses / Pleines, puis la vue ANNUELLE (/api/energy/monthly :
 * curve_pending, curve_floor).
 *   pnpm test:bilan
 *
 * Ce que ces tests protègent : un jour dont la courbe ½h Enedis n'est pas encore
 * arrivée (J, J−1, ou passerelle en panne) doit quand même avoir une répartition
 * HC/HP — estimée d'après la forme EM-50 et MARQUÉE comme telle — au lieu d'une
 * barre vide. En septembre 2026, le mois entier restait sans barre pendant que
 * la cellule du tableau annuel en montrait une : les deux niveaux doivent
 * raconter la même chose. Base SQLite TEMPORAIRE, jamais history.db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'energy-daily-'));
process.chdir(sandbox); // tariffs.json absent → régime par défaut (HC 00:06 → 08:06)
const dbPath = path.join(sandbox, 'history.db');
process.env.RECORDER_DB_PATH = dbPath;

const { parisDayStart } = await import('../src/lib/server/energy-buckets.ts');
const { GET } = await import('../src/routes/api/energy/daily/+server.ts');

// ── Base de test : le paysage du 4 septembre 2026 ──
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE enedis_daily (date TEXT PRIMARY KEY, soutirage_kwh REAL, source TEXT,
    fetched_at INTEGER, hc_kwh REAL, hp_kwh REAL);
  CREATE TABLE savings_daily (date TEXT PRIMARY KEY, wh_hp REAL, wh_hc REAL, eur_hp REAL,
    eur_hc REAL, import_wh REAL, updated_at INTEGER, export_wh REAL);
  CREATE TABLE pv_samples (ts INTEGER PRIMARY KEY, production_w REAL NOT NULL,
    grid_export_w REAL, em50_grid_w REAL);
`);
// 31/08 et 01/09 : courbe arrivée (mesure). 02/09 : total Linky, courbe pas encore là.
db.prepare('INSERT INTO enedis_daily (date, soutirage_kwh, hc_kwh, hp_kwh) VALUES (?,?,?,?)').run(
  '2026-08-31',
  0.164,
  0.014,
  0.15
);
db.prepare('INSERT INTO enedis_daily (date, soutirage_kwh, hc_kwh, hp_kwh) VALUES (?,?,?,?)').run(
  '2026-09-01',
  0.325,
  0.02,
  0.305
);
db.prepare('INSERT INTO enedis_daily (date, soutirage_kwh) VALUES (?,?)').run('2026-09-02', 0.265);
// 03/09 : rien chez Enedis encore, seule la mesure maison.
db.prepare(
  'INSERT INTO savings_daily (date, wh_hp, wh_hc, eur_hp, eur_hc, import_wh) VALUES (?,?,?,?,?,?)'
).run('2026-09-03', 1000, 0, 0.23, 0, 54);

/** Une heure de soutirage EM-50 constant, échantillonnée toutes les 30 s. */
function hourOfImport(day: string, hourParis: number, watts: number): void {
  const start = parisDayStart(day) + hourParis * 3600;
  const ins = db.prepare(
    'INSERT INTO pv_samples (ts, production_w, grid_export_w, em50_grid_w) VALUES (?,0,0,?)'
  );
  for (let t = start; t <= start + 3600; t += 30) ins.run(t, watts);
}
// 02/09 : 300 W pendant une heure de nuit (creuses), 100 W une heure l'après-midi
// (pleines) → part creuses = 75 %.
hourOfImport('2026-09-02', 3, 300);
hourOfImport('2026-09-02', 15, 100);
// 03/09 : soutirage uniquement en journée → 0 % de creuses.
hourOfImport('2026-09-03', 14, 80);
db.close();

async function fetchMonth(month: string) {
  const res = await GET({ url: new URL(`http://domo/api/energy/daily?month=${month}`) } as never);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    days: {
      key: string;
      import_kwh: number;
      import_hc_kwh: number;
      import_hp_kwh: number;
      import_split_source: string | null;
      empty: boolean;
    }[];
    has_curve: boolean;
  };
}

const sept = await fetchMonth('2026-09');
const byKey = new Map(sept.days.map((d) => [d.key, d]));

test('un jour avec courbe garde sa MESURE (source curve)', () => {
  const d = byKey.get('2026-09-01')!;
  assert.equal(d.import_split_source, 'curve');
  assert.ok(Math.abs(d.import_hc_kwh - 0.02) < 1e-9);
  assert.ok(Math.abs(d.import_hp_kwh - 0.305) < 1e-9);
});

test('total Linky sans courbe → répartition estimée EM-50, marquée enedis', () => {
  const d = byKey.get('2026-09-02')!;
  assert.equal(d.import_split_source, 'enedis');
  assert.ok(Math.abs(d.import_kwh - 0.265) < 1e-9, 'le total reste celui du compteur');
  assert.ok(Math.abs(d.import_hc_kwh - 0.265 * 0.75) < 1e-6, `creuses = 75 % (${d.import_hc_kwh})`);
  assert.ok(Math.abs(d.import_hp_kwh - 0.265 * 0.25) < 1e-6);
  assert.ok(Math.abs(d.import_hc_kwh + d.import_hp_kwh - d.import_kwh) < 1e-9, 'HC + HP == total');
});

test('mesure maison seule → tout estimé, marqué local, jamais de creuses inventées', () => {
  const d = byKey.get('2026-09-03')!;
  assert.equal(d.import_split_source, 'local');
  assert.ok(Math.abs(d.import_kwh - 0.054) < 1e-9);
  assert.equal(d.import_hc_kwh, 0);
  assert.ok(Math.abs(d.import_hp_kwh - 0.054) < 1e-9);
});

test('un jour sans aucune donnée reste vide, sans ventilation', () => {
  const d = byKey.get('2026-09-04')!;
  assert.equal(d.empty, true);
  assert.equal(d.import_split_source, null);
  assert.equal(d.import_hc_kwh + d.import_hp_kwh, 0);
});

test('has_curve est faux tant qu’un jour à import attend sa courbe', () => {
  assert.equal(sept.has_curve, false);
});

test('un mois dont tous les jours ont leur courbe est complet (has_curve)', async () => {
  const aout = await fetchMonth('2026-08');
  assert.equal(aout.has_curve, true);
  assert.equal(aout.days.find((d) => d.key === '2026-08-31')?.import_split_source, 'curve');
});

test('un mois d’avant l’EM-50 ne reçoit AUCUNE estimation', async () => {
  const db2 = new Database(dbPath);
  db2
    .prepare('INSERT INTO enedis_daily (date, soutirage_kwh) VALUES (?,?)')
    .run('2025-01-10', 12.5);
  db2.close();
  const jan = await fetchMonth('2025-01');
  const d = jan.days.find((x) => x.key === '2025-01-10')!;
  assert.ok(Math.abs(d.import_kwh - 12.5) < 1e-9);
  assert.equal(d.import_split_source, null);
  assert.equal(d.import_hc_kwh + d.import_hp_kwh, 0);
  assert.equal(jan.has_curve, false);
});

// ── Vue ANNUELLE : « en cours » ne doit plus se dire d'une année hors de portée ──
// Enedis ne conserve la courbe de charge que 24 mois : le backfill s'arrête là.
// Tant que curve_pending disait « en cours » pour 2024, l'UI promettait une
// récupération qui n'arriverait jamais.
const { GET: getMonthly } = await import('../src/routes/api/energy/monthly/+server.ts');

async function fetchYear(year: number) {
  const res = await getMonthly({
    url: new URL(`http://domo/api/energy/monthly?year=${year}`)
  } as never);
  assert.equal(res.status, 200);
  return (await res.json()) as { curve_pending: boolean; curve_floor: string };
}

let dbSeq = 0;
function withCursor(cursor: string): string {
  const p = path.join(sandbox, `monthly-${++dbSeq}-${cursor}.db`);
  const d = new Database(p);
  d.exec(`
    CREATE TABLE enedis_daily (date TEXT PRIMARY KEY, soutirage_kwh REAL, hc_kwh REAL, hp_kwh REAL);
    CREATE TABLE enedis_state (id INTEGER PRIMARY KEY, curve_backfill_cursor TEXT);
  `);
  d.prepare('INSERT INTO enedis_daily (date, soutirage_kwh) VALUES (?,?)').run('2023-08-25', 10);
  d.prepare('INSERT INTO enedis_state (id, curve_backfill_cursor) VALUES (1, ?)').run(cursor);
  d.close();
  return p;
}

test('curve_floor = aujourd’hui − 24 mois, exposé à l’UI', async () => {
  process.env.RECORDER_DB_PATH = withCursor('2024-08-27');
  const r = await fetchYear(2024);
  assert.match(r.curve_floor, /^\d{4}-\d{2}-\d{2}$/);
  const attendu = Date.now() - 730 * 86_400_000;
  assert.ok(Math.abs(Date.parse(r.curve_floor) - attendu) < 2 * 86_400_000, r.curve_floor);
});

test('backfill arrêté au plancher des 24 mois → plus rien n’est « en cours »', async () => {
  process.env.RECORDER_DB_PATH = withCursor('2024-08-27');
  assert.equal((await fetchYear(2024)).curve_pending, false);
  assert.equal((await fetchYear(2023)).curve_pending, false);
});

test('backfill encore en route → les années à sa hauteur ou en dessous attendent', async () => {
  process.env.RECORDER_DB_PATH = withCursor('2025-06-01');
  assert.equal((await fetchYear(2025)).curve_pending, true);
  assert.equal((await fetchYear(2024)).curve_pending, true);
  assert.equal((await fetchYear(2026)).curve_pending, false);
});
