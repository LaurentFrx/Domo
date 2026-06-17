/**
 * Ventilation mensuelle énergie/économies — lecture seule de la base du
 * domo-recorder. Alimente le « Tableau mensuel » de la page Énergie (12 mois
 * d'une année), en remplacement des valeurs mockées.
 *
 * Deux sources, agrégées par mois et fusionnées :
 *  · savings_daily (déjà DATÉE Paris + intégrée HP/HC + gaps gérés par le
 *    recorder) → autoconso_kwh (wh_hp+wh_hc), import_kwh (import_wh),
 *    savings_eur (eur_hp+eur_hc). Mêmes chiffres que /api/savings et la
 *    SavingsCard → aucune contradiction sur la page.
 *  · pv_samples (puissance brute, epoch UTC) → production_kwh (∫ production_w)
 *    et surplus_kwh (∫ grid_export_w), intégrés à la volée (trapèze + plafond de
 *    gap 600 s, identique au recorder). Groupage par mois UTC (le serveur tourne
 *    en UTC ; l'écart de bord Paris < 2 h est négligeable sur un total mensuel).
 *
 * Baseline (économies acquises AVANT le recorder, cf. tariffs.ts) : repliée dans
 * le mois courant tant qu'on est dans le mois d'ancrage — exactement comme la
 * SavingsCard — pour que la cellule « mois courant » du tableau == l'héro.
 *
 * Robustesse (calquée sur /api/savings) : DB absente / verrouillée / illisible →
 * 503 + 12 mois à ZÉRO, jamais de crash. Readonly d'abord, repli rw. Tables pas
 * encore créées (DB neuve) → zéros en 200. Connexion toujours refermée.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import { applicableBaseline, monthlySavingsHistory, parisDate } from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

interface MonthAgg {
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  savings_eur: number;
}

interface MonthlyPayload {
  year: number;
  months: MonthAgg[]; // toujours 12 entrées, index 0 = janvier
  min_year: number; // première année disposant de données (borne du sélecteur)
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

/** Replie la baseline applicable (€/kWh acquis hors période enregistrée) dans le
 * mois courant — uniquement si l'année demandée est l'année courante. Miroir de
 * /api/savings : applicableBaseline(now).month n'est non nul que tant qu'on est
 * dans le mois d'ancrage (qui est alors le mois courant), donc on le range à
 * l'index du mois courant Paris. */
function foldBaseline(months: MonthAgg[], year: number, curYear: number, now: Date): void {
  if (year !== curYear) return;
  const b = applicableBaseline(now);
  const curMonthIdx = Number(parisDate(now).slice(5, 7)) - 1; // 0..11 (Paris)
  if (curMonthIdx < 0 || curMonthIdx > 11) return;
  months[curMonthIdx].savings_eur += b.month.eur;
  months[curMonthIdx].autoconso_kwh += b.month.kwh; // 0 aujourd'hui, mais correct
}

export const GET: RequestHandler = async ({ url }) => {
  const now = new Date();
  const curYear = Number(parisDate(now).slice(0, 4));
  const yReq = Number(url.searchParams.get('year'));
  const year =
    Number.isFinite(yReq) && yReq >= 2000 && yReq <= curYear + 1 ? Math.trunc(yReq) : curYear;

  const path = env.RECORDER_DB_PATH;
  if (!path) {
    return json(
      { year, months: emptyMonths(), error: 'RECORDER_DB_PATH non configurée' },
      { status: 503 }
    );
  }

  let db: Database.Database | null = null;
  try {
    // readonly d'abord ; repli rw si l'ouverture readonly coince (cf. history /
    // savings). Dans tous les cas on n'exécute QUE des SELECT.
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    db.pragma('busy_timeout = 5000');

    const months = emptyMonths();

    // ── savings_daily (Paris) : autoconso / import / économies par mois ──
    const hasSavings = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='savings_daily'")
      .get();
    if (hasSavings) {
      const rows = db
        .prepare(
          'SELECT CAST(substr(date,6,2) AS INTEGER) AS m,' +
            ' COALESCE(SUM(wh_hp+wh_hc),0)/1000.0 AS autoconso_kwh,' +
            ' COALESCE(SUM(import_wh),0)/1000.0 AS import_kwh,' +
            ' COALESCE(SUM(eur_hp+eur_hc),0) AS savings_eur' +
            ' FROM savings_daily WHERE substr(date,1,4) = ? GROUP BY m'
        )
        .all(String(year)) as {
        m: number;
        autoconso_kwh: number;
        import_kwh: number;
        savings_eur: number;
      }[];
      for (const r of rows) {
        const i = r.m - 1;
        if (i >= 0 && i < 12) {
          months[i].autoconso_kwh = Math.max(0, r.autoconso_kwh);
          months[i].import_kwh = Math.max(0, r.import_kwh);
          months[i].savings_eur = Math.max(0, r.savings_eur);
        }
      }
    }

    // ── pv_samples (UTC) : production / surplus par mois (∫ trapèze, gap ≤ 600 s) ──
    // grid_export_w est NULL sur les anciennes lignes (colonne ajoutée après coup)
    // et porte 3 valeurs legacy à −12 W → MAX(0,·) par échantillon avant le trapèze.
    const yStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
    const hasPv = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pv_samples'")
      .get();
    if (hasPv) {
      const rows = db
        .prepare(
          'WITH d AS (' +
            " SELECT CAST(strftime('%m', ts, 'unixepoch') AS INTEGER) AS m," +
            '  ts - LAG(ts) OVER (ORDER BY ts) AS dt,' +
            '  (production_w + LAG(production_w) OVER (ORDER BY ts))/2.0 AS avg_prod,' +
            '  (MAX(0.0,COALESCE(grid_export_w,0))' +
            '   + MAX(0.0,COALESCE(LAG(grid_export_w) OVER (ORDER BY ts),0)))/2.0 AS avg_exp' +
            '  FROM pv_samples WHERE ts >= ? AND ts < ?' +
            ') SELECT m,' +
            ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_prod*dt/3600.0 END),0)/1000.0 AS production_kwh,' +
            ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_exp*dt/3600.0 END),0)/1000.0 AS surplus_kwh' +
            ' FROM d WHERE m IS NOT NULL GROUP BY m'
        )
        .all(yStart, yEnd) as { m: number; production_kwh: number; surplus_kwh: number }[];
      for (const r of rows) {
        const i = r.m - 1;
        if (i >= 0 && i < 12) {
          months[i].production_kwh = Math.max(0, r.production_kwh);
          months[i].surplus_kwh = Math.max(0, r.surplus_kwh);
        }
      }
    }

    // ── Économies importées de HA (pré-recorder) ──
    // Comble savings_eur des mois SANS ligne enregistrée (tous antérieurs à
    // l'ancrage du recorder → aucun recouvrement). N'affecte que la colonne € ;
    // les kWh restent à 0 (« — »), ce détail n'a pas été importé. Déjà comptées
    // dans les totaux via la baseline → purement d'affichage ici.
    const history = monthlySavingsHistory();
    for (let i = 0; i < 12; i++) {
      if (months[i].savings_eur >= 0.005) continue; // donnée enregistrée : on la garde
      const v = history[`${year}-${String(i + 1).padStart(2, '0')}`];
      if (typeof v === 'number' && v > 0) months[i].savings_eur = v;
    }

    // ── Borne basse du sélecteur d'année : première année avec des données ──
    // (économies importées OU lignes savings_daily). Repli : année courante.
    let minYear = curYear;
    for (const k of Object.keys(history)) {
      const y = Number(k.slice(0, 4));
      if (Number.isFinite(y) && y >= 2000 && y < minYear) minYear = y;
    }
    if (hasSavings) {
      const r = db.prepare('SELECT MIN(substr(date,1,4)) AS y FROM savings_daily').get() as {
        y: string | null;
      };
      const y = Number(r?.y);
      if (Number.isFinite(y) && y >= 2000 && y < minYear) minYear = y;
    }

    foldBaseline(months, year, curYear, now);

    const payload: MonthlyPayload = { year, months, min_year: minYear };
    return json(payload);
  } catch (e) {
    // Détail en log serveur SEULEMENT (un message SQLite peut exposer un chemin interne).
    console.error('[energy/monthly] DB error:', e instanceof Error ? e.message : e);
    // DB absente / verrouillée / illisible → 503 + 12 mois ZÉRO, jamais de crash.
    return json({ year, months: emptyMonths(), error: 'database_unavailable' }, { status: 503 });
  } finally {
    try {
      db?.close();
    } catch {
      /* connexion déjà fermée / jamais ouverte : on ignore */
    }
  }
};
