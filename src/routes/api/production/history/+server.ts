/**
 * Historique de production PV — lecture seule de la base du domo-recorder.
 *
 * Sert les points échantillonnés (toutes les 2 min) pour tracer la courbe 24h
 * réelle de la page Énergie. Lit directement le SQLite local du recorder via
 * better-sqlite3 ; jamais exposé au navigateur (route derrière le guard d'auth).
 *
 * Robustesse : DB absente / verrouillée / illisible → 503 avec `points: []`,
 * jamais de crash. La connexion est toujours refermée.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import type { RequestHandler } from './$types';

const SQL = 'SELECT ts, production_w, aps_w, sb_w FROM pv_samples WHERE ts >= ? ORDER BY ts ASC';

export const GET: RequestHandler = async ({ url }) => {
  // Fenêtre demandée : défaut 24 h, bornée 1..168 h (7 j).
  const raw = Number(url.searchParams.get('hours') ?? '24');
  const hours = Number.isFinite(raw) ? Math.min(168, Math.max(1, Math.trunc(raw))) : 24;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  const path = env.RECORDER_DB_PATH;
  if (!path) {
    return json({ points: [], error: 'RECORDER_DB_PATH non configurée' }, { status: 503 });
  }

  let db: Database.Database | null = null;
  try {
    // WAL : on tente readonly ; si l'ouverture readonly coince (accès au -shm),
    // repli en lecture-écriture (le service Domo tourne sous laurent, propriétaire
    // des fichiers). Dans tous les cas on n'exécute QUE des SELECT.
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    // Chevauchement rare avec l'écriture du recorder (1/2 min) → attendre
    // quelques ms plutôt que d'échouer sur un SQLITE_BUSY.
    db.pragma('busy_timeout = 5000');
    const points = db.prepare(SQL).all(since);
    return json({ points });
  } catch (e) {
    // DB absente / verrouillée / illisible → 503 + points vides, jamais de crash.
    return json(
      { points: [], error: e instanceof Error ? e.message : 'db error' },
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
