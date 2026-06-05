/**
 * Économies d'autoconsommation — lecture seule de la base du domo-recorder.
 *
 * Renvoie les économies (énergie consommée par la maison sans venir d'EDF,
 * valorisée au tarif HP/HC évité) agrégées sur 4 horizons : jour, mois, année,
 * total. Les montants viennent de la table savings_daily, accumulée par le
 * recorder à chaque tick ; cette route ne fait que LIRE et agréger.
 *
 * `today` expose en plus le taux live (rate_eur_h, depuis le dernier
 * power_saved enregistré) et le taux de couverture solaire du jour
 * (coverage_pct = part de la conso couverte par le solaire vs import réseau).
 * `total` inclut la baseline (économies/énergie acquises hors période enregistrée).
 *
 * Robustesse (calquée sur /api/production/history) : DB absente / verrouillée /
 * illisible → 503 + payload à ZÉRO, jamais de crash, connexion toujours
 * refermée. Lecture readonly d'abord, repli rw. Table savings_daily pas encore
 * créée (DB neuve) → zéros en 200 (pas d'erreur : juste « rien encore »).
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import { priceAt, applicableBaseline, parisDate } from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

interface PeriodTotals {
  eur: number;
  eur_hp: number;
  eur_hc: number;
  kwh: number;
  kwh_hp: number;
  kwh_hc: number;
}

interface SavingsPayload {
  today: PeriodTotals & { rate_eur_h: number; coverage_pct: number };
  month: PeriodTotals;
  year: PeriodTotals;
  total: PeriodTotals;
}

// Agrégat brut (Wh / €) d'une tranche de savings_daily.
interface RawAgg {
  wh_hp: number;
  wh_hc: number;
  eur_hp: number;
  eur_hc: number;
  import_wh: number;
}

const ZERO_AGG: RawAgg = { wh_hp: 0, wh_hc: 0, eur_hp: 0, eur_hc: 0, import_wh: 0 };

function toPeriod(a: RawAgg): PeriodTotals {
  const kwh_hp = a.wh_hp / 1000;
  const kwh_hc = a.wh_hc / 1000;
  return {
    eur: a.eur_hp + a.eur_hc,
    eur_hp: a.eur_hp,
    eur_hc: a.eur_hc,
    kwh: kwh_hp + kwh_hc,
    kwh_hp,
    kwh_hc
  };
}

function emptyPayload(now: Date): SavingsPayload {
  const z = toPeriod(ZERO_AGG);
  const b = applicableBaseline(now);
  return {
    today: { ...z, rate_eur_h: 0, coverage_pct: 0 },
    // DB vide/indispo, les totaux reflètent quand même les baselines (acquis
    // avant que le recorder n'existe).
    month: { ...z, eur: b.month.eur, kwh: b.month.kwh },
    year: { ...z, eur: b.year.eur, kwh: b.year.kwh },
    total: { ...z, eur: b.total.eur, kwh: b.total.kwh }
  };
}

export const GET: RequestHandler = async () => {
  const now = new Date();
  const path = env.RECORDER_DB_PATH;
  if (!path) {
    return json(
      { ...emptyPayload(now), error: 'RECORDER_DB_PATH non configurée' },
      { status: 503 }
    );
  }

  const today = parisDate(now); // 'YYYY-MM-DD' Paris
  const monthPrefix = today.slice(0, 7); // 'YYYY-MM'
  const yearPrefix = today.slice(0, 4); // 'YYYY'

  let db: Database.Database | null = null;
  try {
    // readonly d'abord ; repli rw si l'ouverture readonly coince (cf. history).
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    db.pragma('busy_timeout = 5000');

    // DB neuve : le recorder n'a pas encore créé savings_daily → zéros propres.
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='savings_daily'")
      .get();
    if (!hasTable) {
      return json(emptyPayload(now));
    }

    const aggSql = (where: string) =>
      'SELECT ' +
      ' COALESCE(SUM(wh_hp),0) AS wh_hp, COALESCE(SUM(wh_hc),0) AS wh_hc,' +
      ' COALESCE(SUM(eur_hp),0) AS eur_hp, COALESCE(SUM(eur_hc),0) AS eur_hc,' +
      ' COALESCE(SUM(import_wh),0) AS import_wh' +
      ` FROM savings_daily${where}`;

    const todayAgg = db.prepare(aggSql(' WHERE date = ?')).get(today) as RawAgg;
    const monthAgg = db.prepare(aggSql(' WHERE substr(date,1,7) = ?')).get(monthPrefix) as RawAgg;
    const yearAgg = db.prepare(aggSql(' WHERE substr(date,1,4) = ?')).get(yearPrefix) as RawAgg;
    const totalAgg = db.prepare(aggSql('')).get() as RawAgg;

    // Taux live : dernier power_saved enregistré × prix courant. Périmé
    // (recorder arrêté, > 10 min) → 0 plutôt qu'une valeur figée trompeuse.
    let rateEurH = 0;
    const hasState = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='savings_state'")
      .get();
    if (hasState) {
      const st = db
        .prepare('SELECT last_ts, last_power_saved_w FROM savings_state WHERE id = 1')
        .get() as { last_ts: number | null; last_power_saved_w: number | null } | undefined;
      if (st && st.last_ts != null && st.last_power_saved_w != null) {
        const ageS = Math.floor(now.getTime() / 1000) - st.last_ts;
        if (ageS >= 0 && ageS <= 600) {
          // Tarif à l'INSTANT DE MESURE (last_ts), pas now : évite d'appliquer
          // le tarif HP à une puissance mesurée en HC si une bascule est survenue
          // dans la fenêtre de 600 s.
          rateEurH = (st.last_power_saved_w / 1000) * priceAt(new Date(st.last_ts * 1000)).eur_kwh;
        }
      }
    }

    // Couverture solaire du jour : part de la conso couverte par le solaire.
    const kwhToday = (todayAgg.wh_hp + todayAgg.wh_hc) / 1000;
    const importKwhToday = todayAgg.import_wh / 1000;
    const denom = kwhToday + importKwhToday;
    // Clamp [0,100] : défensif (ex. import inconnu compté 0 quand l'anker tombe
    // mais l'APS produit → la part évitée pourrait dépasser le dénominateur).
    const coveragePct = denom > 0 ? Math.min(100, (100 * kwhToday) / denom) : 0;

    // Baselines (acquis avant le recorder) ajoutées à .eur/.kwh des périodes
    // concernées — pas de ventilation HP/HC (la carte n'affiche le split que
    // pour « aujourd'hui », qui n'a pas de baseline).
    const b = applicableBaseline(now);
    const monthPeriod = toPeriod(monthAgg);
    const yearPeriod = toPeriod(yearAgg);
    const totalPeriod = toPeriod(totalAgg);

    const payload: SavingsPayload = {
      today: { ...toPeriod(todayAgg), rate_eur_h: rateEurH, coverage_pct: coveragePct },
      month: {
        ...monthPeriod,
        eur: monthPeriod.eur + b.month.eur,
        kwh: monthPeriod.kwh + b.month.kwh
      },
      year: { ...yearPeriod, eur: yearPeriod.eur + b.year.eur, kwh: yearPeriod.kwh + b.year.kwh },
      total: {
        ...totalPeriod,
        eur: totalPeriod.eur + b.total.eur,
        kwh: totalPeriod.kwh + b.total.kwh
      }
    };
    return json(payload);
  } catch (e) {
    // DB absente / verrouillée / illisible → 503 + payload ZÉRO, jamais de crash.
    return json(
      { ...emptyPayload(now), error: e instanceof Error ? e.message : 'db error' },
      { status: 503 }
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* connexion déjà fermée / jamais ouverte : on ignore */
    }
  }
};
