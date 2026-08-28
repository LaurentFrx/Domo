/**
 * Production LIFETIME fiable — lecture seule de la base du domo-recorder.
 *
 * Les compteurs cloud live sont cassés : l'APS EZ1 renvoie parfois `null`, et
 * SURTOUT le cloud SolarBank renvoie depuis la reconfiguration des systèmes Anker
 * (22/07/2026) la production du JOUR à la place du cumul lifetime (bug « daily-as-
 * lifetime »). Le recorder, lui, a historisé les compteurs MATÉRIELS à chaque tick :
 *   - aps_lifetime_kwh  : compteur de l'onduleur EZ1 (pan Sud) — monotone, fiable.
 *   - anker_lifetime_kwh: compteur SolarBank — vrai palier monotone JUSQU'AU 22/07,
 *     puis corrompu par le cloud. Le MAX historisé = la dernière vraie valeur (2042).
 * On renvoie donc le MAX de chaque compteur : robuste au reset (le max ne redescend
 * jamais), l'APS continue de monter, le SolarBank reste figé à son dernier vrai
 * palier (léger sous-comptage assumé tant que le cloud ne se recale pas).
 *
 * Robustesse (calquée sur /api/savings) : DB absente/verrouillée/illisible → 503 +
 * payload à zéro, jamais de crash, connexion toujours refermée.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import type { RequestHandler } from './$types';

interface LifetimePayload {
  available: boolean;
  apsKwh: number;
  ankerKwh: number;
  totalKwh: number;
  error?: string;
}

const empty: LifetimePayload = { available: false, apsKwh: 0, ankerKwh: 0, totalKwh: 0 };

// Cache mémoire : MAX() sans index = full-scan de pv_samples (~25 ms aujourd'hui,
// croissance linéaire), SYNCHRONE dans l'unique process Node. Un cumul lifetime
// bouge de quelques Wh par minute : 5 min de fraîcheur suffisent largement
// (le store client polle à 10 min).
const TTL_MS = 5 * 60_000;
let cache: { at: number; payload: LifetimePayload } | null = null;

export const GET: RequestHandler = async () => {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return json(cache.payload, { headers: { 'cache-control': 'no-store' } });
  }
  const path = env.RECORDER_DB_PATH;
  if (!path) return json({ ...empty, error: 'RECORDER_DB_PATH non configurée' }, { status: 503 });

  let db: Database.Database | null = null;
  try {
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    db.pragma('busy_timeout = 5000');

    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pv_samples'")
      .get();
    if (!has) return json(empty);

    const row = db
      .prepare(
        'SELECT MAX(aps_lifetime_kwh) AS aps, MAX(anker_lifetime_kwh) AS anker FROM pv_samples'
      )
      .get() as { aps: number | null; anker: number | null };

    const apsKwh = typeof row.aps === 'number' && row.aps > 0 ? row.aps : 0;
    const ankerKwh = typeof row.anker === 'number' && row.anker > 0 ? row.anker : 0;
    const totalKwh = apsKwh + ankerKwh;
    const payload: LifetimePayload = { available: totalKwh > 0, apsKwh, ankerKwh, totalKwh };
    cache = { at: Date.now(), payload };
    return json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return json({ ...empty, error: e instanceof Error ? e.message : 'db' }, { status: 503 });
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
};
