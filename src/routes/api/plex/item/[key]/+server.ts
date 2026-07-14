/**
 * DELETE /api/plex/item/<ratingKey> — retire un ALBUM ou une PISTE de la
 * bibliothèque, fichiers compris (gestionnaire de bibliothèque, mode « Gérer »).
 *
 * Voie 1 : DELETE /library/metadata/<key> côté PMS (propre : fichiers + index).
 * Voie 2 (si le PMS répond 403 = « Allow media deletion » désactivé) : on liste
 * les fichiers de l'élément, on les traduit conteneur→hôte (containerPathToHost,
 * qui REFUSE tout chemin hors de la racine musicale), suppression via SSH, puis
 * rescan + emptyTrash de la section pour purger l'index. On ne modifie JAMAIS la
 * préférence serveur (redémarrer Plex casserait l'accès distant, cf. mémoire).
 */
import { error, json } from '@sveltejs/kit';
import {
  containerPathToHost,
  musicSection,
  pmsFetch,
  PlexError,
  shellQuote
} from '$lib/server/plex';
import { partFiles, plexHttp, type RawMeta } from '$lib/server/plex-map';
import { sshExec } from '$lib/server/plex-ssh';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { Metadata?: RawMeta[] };
}

async function metadata(path: string): Promise<RawMeta[]> {
  const res = await pmsFetch(path);
  if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
  return ((await res.json()) as Container).MediaContainer?.Metadata ?? [];
}

/** Fichiers (chemins conteneur) d'une piste ou de toutes les pistes d'un album. */
async function collectFiles(key: string): Promise<string[]> {
  const md = (await metadata(`/library/metadata/${key}`))[0];
  if (!md) throw new PlexError(404, 'Élément introuvable');
  if (md.type === 'track') return partFiles(md);
  if (md.type === 'album') {
    const children = await metadata(`/library/metadata/${key}/children`);
    return children.flatMap(partFiles);
  }
  throw new PlexError(400, `Suppression non gérée pour le type « ${md.type} »`);
}

export const DELETE: RequestHandler = async ({ params }) => {
  const key = params.key;
  if (!/^\d+$/.test(key)) throw error(400, 'Clé invalide');

  try {
    // Voie 1 — API Plex (supprime fichiers + métadonnées d'un coup).
    const res = await pmsFetch(`/library/metadata/${key}`, { method: 'DELETE' });
    if (res.ok) return json({ ok: true, via: 'plex' });
    if (res.status !== 403) throw new PlexError(502, `Plex: HTTP ${res.status}`);

    // Voie 2 — suppression disque via SSH (allowMediaDeletion désactivé).
    const files = await collectFiles(key);
    if (files.length === 0) throw new PlexError(404, 'Aucun fichier à supprimer');
    const hostPaths = await Promise.all(files.map(containerPathToHost));
    await sshExec(`rm -f -- ${hostPaths.map(shellQuote).join(' ')}`);
    // Dossier d'album devenu vide → on le retire aussi (non fatal si non vide).
    const dirs = [...new Set(hostPaths.map((p) => p.replace(/\/[^/]+$/, '')))];
    await sshExec(`rmdir --ignore-fail-on-non-empty -- ${dirs.map(shellQuote).join(' ')}`).catch(
      () => undefined
    );
    // Purge de l'index : rescan + vidage de la corbeille de la section.
    const section = await musicSection();
    await pmsFetch(`/library/sections/${section.key}/refresh`);
    await pmsFetch(`/library/sections/${section.key}/emptyTrash`, { method: 'PUT' });
    return json({ ok: true, via: 'ssh', removed: hostPaths.length });
  } catch (e) {
    plexHttp(e);
  }
};
