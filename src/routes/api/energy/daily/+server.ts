/**
 * Les JOURS d'un mois — deuxième niveau du bilan (année → MOIS → jour).
 *
 * Sources, par ordre de fiabilité, exactement comme la vue mensuelle :
 *  · import du jour = `enedis_daily.soutirage_kwh` (compteur Linky, canonique) ;
 *    repli sur `savings_daily.import_wh` pour les jours qu'Enedis n'a pas encore
 *    publiés (J et J−1) ;
 *  · ventilation HC/HP = `enedis_daily.hc_kwh/hp_kwh` (courbe ½h ventilée à la
 *    minute par le recorder). Absente ⇒ on ne l'invente pas : 0 et l'UI le dit ;
 *  · autoconso et € = `savings_daily` (depuis juin 2026 seulement) ;
 *  · production et surplus = intégrale de `pv_samples` sur les bornes du jour.
 *
 * Robustesse calquée sur /api/energy/monthly : readonly d'abord, gardes par
 * table, 503 + tableau vide plutôt qu'un crash, connexion toujours refermée.
 */
import { json } from '@sveltejs/kit';
import {
  daysInMonth,
  emptyBucket,
  hasTable,
  integrateByEdges,
  openDb,
  parisDayStart,
  type Bucket
} from '$lib/server/energy-buckets';
import type { RequestHandler } from './$types';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const GET: RequestHandler = async ({ url }) => {
  const month = url.searchParams.get('month') ?? '';
  if (!MONTH_RE.test(month)) {
    return json(
      { month, days: [], error: 'paramètre `month` attendu au format YYYY-MM' },
      { status: 400 }
    );
  }

  const db = openDb();
  if (!db) return json({ month, days: [], error: 'database_unavailable' }, { status: 503 });

  try {
    const n = daysInMonth(month);
    const days: Bucket[] = Array.from({ length: n }, (_, i) => {
      const dd = String(i + 1).padStart(2, '0');
      return emptyBucket(String(i + 1), `${month}-${dd}`);
    });
    const byKey = new Map(days.map((d) => [d.key as string, d]));

    // ── Import Linky + ventilation HC/HP (tout l'historique) ──
    if (hasTable(db, 'enedis_daily')) {
      const rows = db
        .prepare(
          'SELECT date, soutirage_kwh AS kwh, hc_kwh, hp_kwh FROM enedis_daily' +
            ' WHERE substr(date,1,7) = ?'
        )
        .all(month) as {
        date: string;
        kwh: number | null;
        hc_kwh: number | null;
        hp_kwh: number | null;
      }[];
      for (const r of rows) {
        const b = byKey.get(r.date);
        if (!b || !Number.isFinite(r.kwh as number)) continue;
        b.import_kwh = Math.max(0, r.kwh as number);
        b.empty = false;
        if (r.hc_kwh !== null && r.hp_kwh !== null) {
          b.import_hc_kwh = Math.max(0, r.hc_kwh);
          b.import_hp_kwh = Math.max(0, r.hp_kwh);
          b.import_split_source = 'curve'; // ventilée à la minute par le recorder
        }
      }
    }

    // ── Autoconso, économies, et import de repli (jours pas encore publiés) ──
    if (hasTable(db, 'savings_daily')) {
      const rows = db
        .prepare(
          'SELECT date, (wh_hp+wh_hc)/1000.0 AS auto, (eur_hp+eur_hc) AS eur,' +
            ' import_wh/1000.0 AS imp FROM savings_daily WHERE substr(date,1,7) = ?'
        )
        .all(month) as { date: string; auto: number; eur: number; imp: number }[];
      for (const r of rows) {
        const b = byKey.get(r.date);
        if (!b) continue;
        if (Number.isFinite(r.auto) && r.auto > 0) {
          b.autoconso_kwh = Math.max(0, r.auto);
          b.empty = false;
        }
        if (Number.isFinite(r.eur) && r.eur > 0) b.savings_eur = Math.max(0, r.eur);
        // Repli d'import UNIQUEMENT si Enedis n'a rien publié pour ce jour :
        // les deux sources ne doivent jamais s'additionner.
        if (b.import_kwh <= 0 && Number.isFinite(r.imp) && r.imp > 0) {
          b.import_kwh = Math.max(0, r.imp);
          b.empty = false;
        }
      }
    }

    // ── Surplus injecté (compteur local EM-50) ──
    if (hasTable(db, 'em50_daily')) {
      const rows = db
        .prepare('SELECT date, export_wh/1000.0 AS kwh FROM em50_daily WHERE substr(date,1,7) = ?')
        .all(month) as { date: string; kwh: number }[];
      for (const r of rows) {
        const b = byKey.get(r.date);
        if (b && Number.isFinite(r.kwh) && r.kwh > 0) b.surplus_kwh = Math.max(0, r.kwh);
      }
    }

    // ── Production PV : intégrale sur les bornes de chaque jour (Paris) ──
    if (hasTable(db, 'pv_samples')) {
      const edges = days.map((d) => parisDayStart(d.key as string));
      edges.push(parisDayStart(`${month}-${String(n).padStart(2, '0')}`) + 86400);
      const prod = integrateByEdges(db, 'production_w', edges);
      for (let i = 0; i < days.length; i++) {
        if (prod[i] > 0.001) {
          days[i].production_kwh = prod[i];
          days[i].empty = false;
        }
      }
    }

    return json({ month, days });
  } catch (e) {
    console.error('[energy/daily] DB error:', e instanceof Error ? e.message : e);
    return json({ month, days: [], error: 'database_unavailable' }, { status: 503 });
  } finally {
    try {
      db.close();
    } catch {
      /* déjà fermée */
    }
  }
};
