/**
 * L'historique de l'ancien contrat EDF (Tarif Bleu HP/HC) dans le bilan de la
 * page Énergie : volume des mois sans autre source, ventilation Creuses /
 * Pleines tirée des registres Linky, priorités entre sources.
 *   pnpm test:edf
 *
 * Ce que ces tests protègent : une estimation EDF ne doit jamais passer pour
 * une mesure ni doubler un autre total ; un intervalle de relevés qui enjambe
 * deux mois doit nourrir les deux au prorata de leurs jours ; les seuils (tout
 * le mois en relevés quotidiens pour une mesure, 40 % de couverture pour une
 * estimation) doivent tenir. Données SYNTHÉTIQUES (le dépôt est public), base
 * SQLite TEMPORAIRE, jamais history.db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'edf-history-'));
process.chdir(sandbox);
// Relevés saisis : juillet 2001 (sans autre volume) et janvier 2002 (qui a
// aussi des index quotidiens et un total Enedis).
await fs.mkdir('data');
await fs.writeFile(
  'data/tariffs.json',
  JSON.stringify({
    regimes: [
      { from: '2000-01-01', hp_eur_kwh: 0.2, hc_eur_kwh: 0.15, hc_windows: [['00:06', '08:06']] }
    ],
    monthly_import_hc_kwh: { '2001-07': 100, '2002-01': 50 },
    monthly_import_hp_kwh: { '2001-07': 300, '2002-01': 50 }
  })
);
const dbPath = path.join(sandbox, 'history.db');
process.env.RECORDER_DB_PATH = dbPath;

const { edfHistory, indexSplits } = await import('../src/lib/server/edf-history.ts');
const { GET: getMonthly } = await import('../src/routes/api/energy/monthly/+server.ts');
const { GET: getDaily } = await import('../src/routes/api/energy/daily/+server.ts');
const { GET: getHourly } = await import('../src/routes/api/energy/hourly/+server.ts');

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

/** Relevés quotidiens de `from` à `to` inclus : +6 HP et +4 HC par jour. */
function dailyIndex(from: string, to: string, hp0: number, hc0: number) {
  const rows: { date: string; hp_kwh: number; hc_kwh: number }[] = [];
  for (let t = Date.parse(from), k = 0; t <= Date.parse(to); t += 86_400_000, k++)
    rows.push({
      date: new Date(t).toISOString().slice(0, 10),
      hp_kwh: hp0 + 6 * k,
      hc_kwh: hc0 + 4 * k
    });
  return rows;
}

// ── Registres relevés au mois (le 28), dont un intervalle de 61 jours ──
const MONTHLY_INDEX = [
  { date: '2001-04-28', hp_kwh: 1000, hc_kwh: 500 },
  { date: '2001-05-28', hp_kwh: 1300, hc_kwh: 600 }, // 30 j : +10 HP/j, +3,33 HC/j
  { date: '2001-07-28', hp_kwh: 1910, hc_kwh: 905 }, // 61 j (relevé du 28/06 manquant) : +10/j, +5/j
  { date: '2001-08-28', hp_kwh: 2220, hc_kwh: 1060 } // 31 j : +10/j, +5/j
];

test('un intervalle de 61 jours nourrit les deux mois qu’il enjambe, au prorata', () => {
  const { monthSplit, dayHcShare } = indexSplits(MONTHLY_INDEX);
  // Juin est tout entier dans l'intervalle 28/05 → 28/07 : 300 HP, 150 HC.
  near(monthSplit.get('2001-06')!.hcShare, 1 / 3);
  assert.equal(monthSplit.get('2001-06')!.source, 'index_est');
  // Mai : 27 jours du premier intervalle (10 + 3,33/j) + 4 du second (10 + 5/j).
  near(monthSplit.get('2001-05')!.hcShare, 110 / 420);
  // Avril : 3 jours couverts sur 30 → rien à dire du mois.
  assert.equal(monthSplit.has('2001-04'), false);
  // Août : 27 jours sur 31 → estimation.
  assert.equal(monthSplit.get('2001-08')!.source, 'index_est');
  // Aucun relevé quotidien → aucune part journalière.
  assert.equal(dayHcShare.size, 0);
});

test('seuils : tout le mois en relevés quotidiens = mesure ; 40 % couverts = estimation', () => {
  // Juin 2002 entier en relevés quotidiens (1/06 → 1/07) : la mesure.
  const full = indexSplits(dailyIndex('2002-06-01', '2002-07-01', 0, 0));
  assert.equal(full.monthSplit.get('2002-06')!.source, 'index');
  near(full.monthSplit.get('2002-06')!.hcShare, 0.4);
  near(full.dayHcShare.get('2002-06-15')!, 0.4);
  // 28 jours quotidiens + un intervalle de 2 jours : couvert à 100 %, mais
  // plus une mesure jour par jour.
  const presque = indexSplits([
    ...dailyIndex('2002-06-01', '2002-06-29', 0, 0),
    { date: '2002-07-01', hp_kwh: 6 * 28 + 12, hc_kwh: 4 * 28 + 8 }
  ]);
  assert.equal(presque.monthSplit.get('2002-06')!.source, 'index_est');
  assert.equal(presque.dayHcShare.has('2002-06-29'), false, 'un jour de l’intervalle de 2 j');
  // 12 jours sur 30 = 40 % pile → estimation ; 11 jours → rien.
  assert.equal(
    indexSplits(dailyIndex('2002-06-01', '2002-06-13', 0, 0)).monthSplit.get('2002-06')!.source,
    'index_est'
  );
  assert.equal(
    indexSplits(dailyIndex('2002-06-01', '2002-06-12', 0, 0)).monthSplit.has('2002-06'),
    false
  );
});

// ── Base de test ──
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE enedis_daily (date TEXT PRIMARY KEY, soutirage_kwh REAL, source TEXT,
    fetched_at INTEGER, hc_kwh REAL, hp_kwh REAL);
  CREATE TABLE edf_index (date TEXT PRIMARY KEY, hp_kwh INTEGER NOT NULL,
    hc_kwh INTEGER NOT NULL, source TEXT NOT NULL);
  CREATE TABLE edf_monthly (month TEXT PRIMARY KEY, kwh REAL NOT NULL,
    nature TEXT NOT NULL CHECK (nature IN ('reelle','estimee')), source TEXT NOT NULL);
  CREATE TABLE edf_daily (date TEXT PRIMARY KEY, kwh INTEGER NOT NULL,
    nature TEXT NOT NULL, source TEXT NOT NULL);
`);
const insIndex = db.prepare("INSERT INTO edf_index VALUES (?,?,?,'test')");
for (const r of [
  ...MONTHLY_INDEX,
  // Janvier et février 2002 en relevés quotidiens (1/01 → 1/03) : part HC 0,4.
  ...dailyIndex('2002-01-01', '2002-03-01', 5000, 3000)
])
  insIndex.run(r.date, r.hp_kwh, r.hc_kwh);
const insMonthly = db.prepare("INSERT INTO edf_monthly VALUES (?,?,?,'test')");
insMonthly.run('2000-12', 1500, 'estimee'); // premier mois connu, et le plus gros
insMonthly.run('2001-05', 420, 'reelle');
insMonthly.run('2001-06', 460, 'estimee');
insMonthly.run('2001-07', 465, 'estimee'); // un relevé saisi existe aussi
insMonthly.run('2002-01', 999, 'estimee'); // Enedis a ce mois : ignoré
const insEnedis = db.prepare(
  'INSERT INTO enedis_daily (date, soutirage_kwh, hc_kwh, hp_kwh) VALUES (?,?,?,?)'
);
insEnedis.run('2001-08-10', 12, null, null); // un jour pris dans un intervalle d'un mois
for (let d = 1; d <= 31; d++)
  insEnedis.run(`2002-01-${String(d).padStart(2, '0')}`, 10, null, null);
// Février 2002 : courbe ½h complète (part HC 0,3) ET index quotidiens (0,4).
for (let d = 1; d <= 28; d++) insEnedis.run(`2002-02-${String(d).padStart(2, '0')}`, 10, 3, 7);
db.close();

type Month = {
  import_kwh: number;
  import_hc_kwh: number;
  import_hp_kwh: number;
  import_split_source: string | null;
  import_estimated: boolean;
  has_daily: boolean;
};

async function fetchYear(year: number) {
  const res = await getMonthly({
    url: new URL(`http://domo/api/energy/monthly?year=${year}`)
  } as never);
  assert.equal(res.status, 200);
  return (await res.json()) as { months: Month[]; min_year: number; scale_max_kwh: number };
}

const y2001 = await fetchYear(2001);
const y2002 = await fetchYear(2002);

test('mois sans aucune autre source → volume EDF, estimation marquée', () => {
  const juin = y2001.months[5];
  assert.equal(juin.import_kwh, 460);
  assert.equal(juin.import_estimated, true);
  assert.equal(juin.import_split_source, 'index_est');
  near(juin.import_hc_kwh, 460 / 3);
  near(juin.import_hc_kwh + juin.import_hp_kwh, juin.import_kwh);
  const mai = y2001.months[4];
  assert.equal(mai.import_kwh, 420);
  assert.equal(mai.import_estimated, false, 'un mois « Réelle » n’est pas estimé');
});

test('relevé saisi > EDF pour le volume ; relevé > index au prorata pour la répartition', () => {
  const juillet = y2001.months[6];
  assert.equal(juillet.import_kwh, 400, 'le relevé saisi fait le volume, pas EDF');
  assert.equal(juillet.import_estimated, false);
  assert.equal(juillet.import_split_source, 'meter');
  near(juillet.import_hc_kwh, 100);
});

test('index quotidiens > relevé saisi, appliqués au total Enedis (jamais au volume EDF)', () => {
  const jan = y2002.months[0];
  assert.equal(jan.import_kwh, 310, 'volume Enedis, l’estimation EDF de 999 est ignorée');
  assert.equal(jan.import_estimated, false);
  assert.equal(jan.import_split_source, 'index');
  near(jan.import_hc_kwh, 310 * 0.4);
  near(jan.import_hc_kwh + jan.import_hp_kwh, jan.import_kwh);
});

test('courbe ½h complète > index quotidiens', () => {
  const fev = y2002.months[1];
  assert.equal(fev.import_split_source, 'curve');
  near(fev.import_hc_kwh, 280 * 0.3);
});

test('sélecteur, échelle et descente : l’historique EDF compte, sans fabriquer de jours', () => {
  assert.equal(y2002.min_year, 2000);
  assert.equal(y2002.scale_max_kwh, 1500);
  assert.equal(y2001.months[5].has_daily, false, 'juin 2001 : total mensuel seul');
  assert.equal(y2001.months[7].has_daily, true, 'août 2001 : un jour Enedis');
  assert.equal(y2002.months[0].has_daily, true);
});

test('jours : index encadrés → mesure « index » ; jour pris dans un long intervalle → rien', async () => {
  const res = await getDaily({
    url: new URL('http://domo/api/energy/daily?month=2002-01')
  } as never);
  const jan = (await res.json()) as { days: Month[]; has_curve: boolean };
  const d = jan.days[14];
  assert.equal(d.import_split_source, 'index');
  near(d.import_hc_kwh, 4);
  near(d.import_hp_kwh, 6);
  assert.equal(jan.has_curve, true, 'une ventilation par index est définitive');
  const fev = (await (
    await getDaily({ url: new URL('http://domo/api/energy/daily?month=2002-02') } as never)
  ).json()) as { days: Month[] };
  assert.equal(fev.days[9].import_split_source, 'curve');
  const aout = (await (
    await getDaily({ url: new URL('http://domo/api/energy/daily?month=2001-08') } as never)
  ).json()) as { days: Month[] };
  assert.equal(aout.days[9].import_kwh, 12);
  assert.equal(aout.days[9].import_split_source, null);
});

test('vue horaire : au-delà de 24 mois sans courbe, « hors d’atteinte » ; hier, non', async () => {
  const hourly = async (date: string) =>
    (await (
      await getHourly({ url: new URL(`http://domo/api/energy/hourly?date=${date}`) } as never)
    ).json()) as { has_curve: boolean; curve_out_of_reach: boolean };
  assert.equal((await hourly('2001-06-15')).curve_out_of_reach, true);
  const hier = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.equal((await hourly(hier)).curve_out_of_reach, false);
});

test('retour arrière (DROP des tables EDF) → comportement d’avant, sans redémarrage', async () => {
  const w = new Database(dbPath);
  w.exec('DROP TABLE edf_index; DROP TABLE edf_monthly; DROP TABLE edf_daily;');
  assert.equal(edfHistory(w), null);
  w.close();
  const y = await fetchYear(2001);
  assert.equal(y.months[5].import_kwh, 0);
  assert.equal(y.months[5].import_split_source, null);
  assert.equal(y.min_year, 2001);
});
