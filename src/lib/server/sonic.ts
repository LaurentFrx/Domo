/**
 * Similarité sonique MAISON — le remplaçant de la « sonic analysis » Plex que
 * le PMS du RPi4 (ARM) ne sait pas produire.
 *
 * `data/sonic.db` est produite par l'analyseur du VPS (systemd
 * sonic-analyzer, script /home/laurent/sonic-analyzer/analyze.py, HORS GIT —
 * pattern domo-recorder) : un vecteur discogs-effnet 1280-d, normalisé L2,
 * par piste (clé = ratingKey PMS). Cosinus = simple produit scalaire.
 *
 * L'index complet est chargé en mémoire (~36 Mo pour 7 000 pistes) et un
 * plus-proches-voisins brut le parcourt en quelques ms — pas besoin d'index
 * vectoriel à cette échelle. Rechargé quand la base change (mtime du .db ET
 * du -wal : sous WAL, l'écriture vit d'abord dans le journal), vérifié au
 * plus une fois par minute — l'analyseur tourne la nuit (et en continu
 * pendant le lot initial).
 *
 * Base absente (installation neuve, dev) : tout répond « pas d'analyse » et
 * les DJ soniques se replient — jamais d'erreur.
 */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const DB_FILE = path.resolve(process.cwd(), 'data', 'sonic.db');
const RECHECK_MS = 60_000;

interface SonicIndex {
  keys: string[];
  pos: Map<string, number>;
  dim: number;
  /** Matrice (n × dim) aplatie, vecteurs déjà normalisés. */
  mat: Float32Array;
  model: string | null;
}

let cached: { idx: SonicIndex | null; stamp: number; checkedAt: number } | null = null;

/** Horodatage combiné db + wal (l'un ou l'autre bouge selon les checkpoints). */
function dbStamp(): number {
  try {
    const m = fs.statSync(DB_FILE).mtimeMs;
    let w = 0;
    try {
      w = fs.statSync(DB_FILE + '-wal').mtimeMs;
    } catch {
      /* pas de journal : base au repos */
    }
    return Math.max(m, w);
  } catch {
    return 0; // base absente
  }
}

function loadIndex(): SonicIndex | null {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT key, dim, v FROM vec').all() as Array<{
      key: string;
      dim: number;
      v: Buffer;
    }>;
    if (rows.length === 0) return null;
    const dim = rows[0].dim;
    const keys: string[] = [];
    const mat = new Float32Array(rows.length * dim);
    let n = 0;
    for (const r of rows) {
      if (r.dim !== dim || r.v.length !== dim * 4) continue; // vecteur d'un autre modèle
      keys.push(r.key);
      mat.set(new Float32Array(r.v.buffer, r.v.byteOffset, dim), n * dim);
      n++;
    }
    const model =
      (db.prepare("SELECT v FROM meta WHERE k='model'").get() as { v: string } | undefined)?.v ??
      null;
    const pos = new Map(keys.map((k, i) => [k, i]));
    return { keys, pos, dim, mat: mat.subarray(0, n * dim), model };
  } catch {
    return null; // base absente ou illisible : pas d'analyse
  } finally {
    db?.close();
  }
}

function index(): SonicIndex | null {
  const now = Date.now();
  if (cached && now - cached.checkedAt < RECHECK_MS) return cached.idx;
  const stamp = dbStamp();
  if (cached && cached.stamp === stamp) {
    cached.checkedAt = now;
    return cached.idx;
  }
  cached = { idx: stamp ? loadIndex() : null, stamp, checkedAt: now };
  return cached.idx;
}

/** État de l'analyse (grise/dégrise les DJ soniques côté client). */
export function sonicStatus(): { analyzed: number; model: string | null } {
  const idx = index();
  return { analyzed: idx?.keys.length ?? 0, model: idx?.model ?? null };
}

/**
 * Les `limit` pistes les plus proches de `key`, hors exclusions, par
 * similarité décroissante. `null` = pas d'index ou piste non analysée.
 */
export function sonicSimilar(key: string, exclude: Set<string>, limit: number): string[] | null {
  const idx = index();
  if (!idx) return null;
  const p = idx.pos.get(key);
  if (p === undefined) return null;
  const { dim, mat, keys } = idx;
  const q = mat.subarray(p * dim, (p + 1) * dim);
  // Tas du pauvre : on garde les `limit` meilleurs scores en tableau trié —
  // limit est petit (≤ 50), le coût reste O(n·dim + n·log limit).
  const best: Array<{ k: string; s: number }> = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === key || exclude.has(k)) continue;
    let s = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) s += mat[off + d] * q[d];
    if (best.length < limit) {
      best.push({ k, s });
      if (best.length === limit) best.sort((a, b) => b.s - a.s);
    } else if (s > best[limit - 1].s) {
      best[limit - 1] = { k, s };
      best.sort((a, b) => b.s - a.s);
    }
  }
  if (best.length < limit) best.sort((a, b) => b.s - a.s);
  return best.map((b) => b.k);
}
