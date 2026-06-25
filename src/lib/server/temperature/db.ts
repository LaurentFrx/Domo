/**
 * Base SQLite dédiée à l'historique de température (`data/temps.db`).
 *
 * Domo est le SEUL writer (≠ history.db du recorder) → pas de contention de
 * verrou ni de violation de l'invariant writer/reader du recorder. better-sqlite3
 * est synchrone et Node mono-thread : l'insertion du tick et la lecture de la
 * route ne s'interleavent jamais dans l'event loop. Une SEULE connexion
 * module-level partagée (lecture + écriture), PRAGMA posés une fois.
 */

import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import path from 'node:path';

export interface Sample {
  sensor: string;
  /** epoch secondes (arrondi minute par le collecteur). */
  ts: number;
  /** °C, ou null si valeur indisponible / périmée (trou honnête). */
  tempC: number | null;
  /** Âge (ms) de la mesure source à l'échantillonnage (diagnostic). */
  ageMs: number | null;
}

export interface Point {
  ts: number;
  c: number | null;
}

let db: Database.Database | null = null;

function conn(): Database.Database {
  if (db) return db;
  const file = env.TEMPS_DB_PATH || path.resolve(process.cwd(), 'data', 'temps.db');
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  d.pragma('busy_timeout = 5000');
  d.exec(
    `CREATE TABLE IF NOT EXISTS temp_samples (
       sensor TEXT NOT NULL,
       ts     INTEGER NOT NULL,   -- epoch secondes (arrondi minute)
       temp_c REAL,               -- null = trou (source absente/périmée)
       age_ms INTEGER,            -- fraîcheur de la mesure à l'échantillonnage
       PRIMARY KEY (sensor, ts)
     )`
  );
  db = d;
  return d;
}

/**
 * Insère un lot d'échantillons en UNE transaction (write atomique).
 *
 * Collision (même sensor+minute, ex. tick manuel + timer, ou cache MQTT encore
 * froid au 1er tick d'une minute puis chaud au suivant) → on PRIVILÉGIE une
 * valeur réelle : on n'écrase jamais un point connu par un `null`, mais un
 * `null` (ou un point plus ancien) est remplacé par la mesure non-null arrivée
 * ensuite dans la même minute.
 */
export function insertSamples(samples: Sample[]): void {
  if (samples.length === 0) return;
  const d = conn();
  const stmt = d.prepare(
    `INSERT INTO temp_samples (sensor, ts, temp_c, age_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(sensor, ts) DO UPDATE SET
       temp_c = CASE WHEN excluded.temp_c IS NOT NULL THEN excluded.temp_c ELSE temp_samples.temp_c END,
       age_ms = CASE WHEN excluded.temp_c IS NOT NULL THEN excluded.age_ms ELSE temp_samples.age_ms END`
  );
  const tx = d.transaction((rows: Sample[]) => {
    for (const r of rows) stmt.run(r.sensor, r.ts, r.tempC, r.ageMs);
  });
  tx(samples);
}

/** Série d'un capteur depuis `sinceSec` (epoch s), ordre chronologique. */
export function querySeries(sensor: string, sinceSec: number): Point[] {
  const d = conn();
  return d
    .prepare(
      `SELECT ts, temp_c AS c FROM temp_samples
       WHERE sensor = ? AND ts >= ? ORDER BY ts ASC`
    )
    .all(sensor, sinceSec) as Point[];
}

/** Rétention : supprime les points plus vieux que `beforeSec`. */
export function purgeOld(beforeSec: number): void {
  const d = conn();
  d.prepare(`DELETE FROM temp_samples WHERE ts < ?`).run(beforeSec);
}
