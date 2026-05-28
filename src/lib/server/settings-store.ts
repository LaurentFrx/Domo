/**
 * Persistance serveur des réglages utilisateur — fichier JSON local.
 *
 * Le client appelle GET/PUT /api/settings, qui délègue ici.
 * Stockage : `data/settings.json` à la racine du projet (gitignored).
 *
 * Convention : un seul fichier, structure ouverte (any key/value
 * sérialisable). Le front décide du shape via le store preferences.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export type Settings = Record<string, unknown>;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw) as Settings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

/** Merge des clés fournies dans le JSON existant. */
export async function writeSettings(partial: Settings): Promise<Settings> {
  await ensureDataDir();
  const current = await readSettings();
  const merged = { ...current, ...partial };
  // Écriture atomique : tmp + rename pour éviter un fichier corrompu en cas
  // de crash en plein write.
  const tmp = SETTINGS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  await fs.rename(tmp, SETTINGS_FILE);
  return merged;
}
