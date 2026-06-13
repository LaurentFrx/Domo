/**
 * Historique EM-50 — lecture seule du domo-recorder (tables pv_samples + em50_daily).
 *
 * Sert (1) les points 24 h du réseau réel signé + conso cumulus (mesure LOCALE
 * EM-50, fiable, indépendante du cloud Solix) pour la courbe « Conso / Réseau »
 * de la page Énergie ; (2) les totaux du JOUR (import / export réseau + conso
 * cumulus, kWh). Lit directement le SQLite local via better-sqlite3 ; jamais
 * exposé au navigateur (route derrière le guard d'auth de hooks.server.ts).
 *
 * Robustesse calquée sur /api/production/history : DB absente / verrouillée /
 * illisible → 503 propre (points vides + today à 0), jamais de crash, connexion
 * toujours refermée. La table em50_daily peut manquer sur une base d'avant la
 * migration EM-50 → lecture isolée (today à 0, pas d'erreur).
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import { parisDate } from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

const POINTS_SQL =
  'SELECT ts, em50_grid_w, em50_cumulus_w FROM pv_samples ' +
  'WHERE ts >= ? AND em50_grid_w IS NOT NULL ORDER BY ts ASC';
const TODAY_SQL = 'SELECT import_wh, export_wh, cumulus_wh FROM em50_daily WHERE date = ?';

const EMPTY_TODAY = { import_kwh: 0, export_kwh: 0, cumulus_kwh: 0 };

export const GET: RequestHandler = async ({ url }) => {
  // Fenêtre demandée : défaut 24 h, bornée 1..168 h (7 j).
  const raw = Number(url.searchParams.get('hours') ?? '24');
  const hours = Number.isFinite(raw) ? Math.min(168, Math.max(1, Math.trunc(raw))) : 24;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  const path = env.RECORDER_DB_PATH;
  if (!path) {
    return json(
      { points: [], today: EMPTY_TODAY, error: 'RECORDER_DB_PATH non configurée' },
      { status: 503 }
    );
  }

  let db: Database.Database | null = null;
  try {
    // readonly d'abord ; repli rw si l'ouverture readonly coince (cf. history).
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    db.pragma('busy_timeout = 5000');
    const points = db.prepare(POINTS_SQL).all(since);

    // Totaux du jour (Europe/Paris). Table absente (base pré-EM-50) → today à 0.
    let today = EMPTY_TODAY;
    try {
      const r = db.prepare(TODAY_SQL).get(parisDate(new Date())) as
        | { import_wh: number; export_wh: number; cumulus_wh: number }
        | undefined;
      if (r) {
        today = {
          import_kwh: (r.import_wh ?? 0) / 1000,
          export_kwh: (r.export_wh ?? 0) / 1000,
          cumulus_kwh: (r.cumulus_wh ?? 0) / 1000
        };
      }
    } catch {
      /* table em50_daily pas encore créée : today reste à 0 */
    }

    return json({ points, today });
  } catch (e) {
    // Détail en log serveur SEULEMENT (un message SQLite peut exposer un chemin interne).
    console.error('[em50/history] DB error:', e instanceof Error ? e.message : e);
    return json({ points: [], today: EMPTY_TODAY, error: 'database_unavailable' }, { status: 503 });
  } finally {
    try {
      db?.close();
    } catch {
      /* connexion déjà fermée / jamais ouverte : on ignore */
    }
  }
};
