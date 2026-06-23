/**
 * Persistance serveur des réglages utilisateur — fichier JSON local.
 *
 * Le client appelle GET/PUT /api/settings, qui délègue ici.
 * Stockage : `data/settings.json` à la racine du projet (gitignored).
 *
 * Convention : un seul fichier, structure ouverte (any key/value
 * sérialisable). Le front décide du shape via le store preferences.
 *
 * Durabilité & intégrité : via `atomic-store` (écriture fsync + .bak, lecture
 * auto-réparante sur corruption). Le seul invariant imposé ici est que le contenu
 * soit un OBJET (sinon un `[]`/scalaire casserait le merge `{ ...current }`).
 */
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './atomic-store';

const SETTINGS_FILE = path.resolve(process.cwd(), 'data', 'settings.json');

export type Settings = Record<string, unknown>;

const asObject = (raw: unknown): Settings =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Settings) : {};

export async function readSettings(): Promise<Settings> {
  return readJsonSafe(SETTINGS_FILE, {
    fallback: () => ({}),
    normalize: asObject,
    label: 'settings.json'
  });
}

/** Merge des clés fournies dans le JSON existant. Rejette un payload non-objet. */
export async function writeSettings(partial: Settings): Promise<Settings> {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('settings: le payload doit être un objet');
  }
  const current = await readSettings();
  const merged = { ...current, ...partial };
  await writeJsonAtomic(SETTINGS_FILE, merged);
  return merged;
}
