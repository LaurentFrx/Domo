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
import {
  anchorMonthBaseline,
  monthlyImportHcHistory,
  monthlyImportHpHistory,
  monthlySavingsHistory,
  parisDate
} from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

interface MonthAgg {
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  import_hc_kwh: number;
  import_hp_kwh: number;
  /** Import RÉELLEMENT MESURÉ ce mois par le recorder (savings_daily), AVANT tout
   * remplacement par un relevé compteur mensuel. Cohérent en période avec
   * autoconso_kwh → base du KPI d'autosuffisance (≠ import_kwh, qui privilégie le
   * relevé facturé pour le tableau). */
  import_live_kwh: number;
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
    import_hc_kwh: 0,
    import_hp_kwh: 0,
    import_live_kwh: 0,
    savings_eur: 0
  };
}

function emptyMonths(): MonthAgg[] {
  return Array.from({ length: 12 }, zeroMonth);
}

/** Replie la baseline du MOIS D'ANCHOR (part pré-recorder du mois où le recorder a
 * démarré) dans la cellule de CE mois-là — de façon PERMANENTE, pas seulement le
 * mois où on s'y trouve. Le mois d'anchor est un mois split (ex. juin 2026 :
 * 1→5 pré-recorder = baseline.month_eur, 5→30 = savings_daily) ; sans ce report,
 * la cellule perd la part pré-recorder dès qu'on passe au mois suivant (juin
 * retombait de ~102 € à 89,47 €). N'affecte que l'année de l'anchor. Le total de
 * l'année du tableau recolle alors à /api/savings.year (source de vérité). */
function foldBaseline(months: MonthAgg[], year: number): void {
  const a = anchorMonthBaseline();
  if (!a || a.year !== year) return;
  months[a.monthIndex].savings_eur += a.eur;
  months[a.monthIndex].autoconso_kwh += a.kwh; // 0 aujourd'hui (month_kwh=0), mais correct
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

    // Import « live » = ce que le recorder a effectivement mesuré ce mois
    // (savings_daily), AVANT tout remplacement par un relevé compteur mensuel
    // ci-dessous. Base du KPI d'autosuffisance, cohérent en période avec l'autoconso.
    for (let i = 0; i < 12; i++) months[i].import_live_kwh = months[i].import_kwh;

    // ── Imports réseau relevés au compteur, ventilés HC / HP (pré-recorder) ──
    // Relevés Linky/EDF (= facturés) → source de vérité. Quand un mois a un relevé,
    // il PRIME sur le recorder (≠ logique des économies) : le recorder ne ventile
    // pas l'import HP/HC, et ses chiffres du mois COURANT sont moins fiables (ex.
    // juin 2026, données HA erronées). import_kwh = HC + HP. Les mois SANS relevé
    // gardent le total recorder (sans ventilation → HC/HP restent à 0).
    const importHc = monthlyImportHcHistory();
    const importHp = monthlyImportHpHistory();
    for (let i = 0; i < 12; i++) {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      const hc = importHc[key];
      const hp = importHp[key];
      const hasHc = typeof hc === 'number' && hc > 0;
      const hasHp = typeof hp === 'number' && hp > 0;
      if (!hasHc && !hasHp) continue; // aucun relevé manuel → on garde le recorder
      months[i].import_hc_kwh = hasHc ? hc : 0;
      months[i].import_hp_kwh = hasHp ? hp : 0;
      months[i].import_kwh = months[i].import_hc_kwh + months[i].import_hp_kwh;
    }

    // ── Borne basse du sélecteur d'année : première année avec des données ──
    // (économies importées OU lignes savings_daily). Repli : année courante.
    let minYear = curYear;
    for (const k of [...Object.keys(history), ...Object.keys(importHc), ...Object.keys(importHp)]) {
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

    foldBaseline(months, year);

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
