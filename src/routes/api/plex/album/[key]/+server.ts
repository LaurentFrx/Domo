/**
 * GET /api/plex/album/<ratingKey> — un album + ses pistes (ordre disque/piste).
 * Réponse : { album, tracks } (formes compactes de plex-map).
 */
import { error, json } from '@sveltejs/kit';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { mapAlbum, mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { Metadata?: RawMeta[] };
}

async function metadata(path: string): Promise<RawMeta[]> {
  const res = await pmsFetch(path);
  if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
  return ((await res.json()) as Container).MediaContainer?.Metadata ?? [];
}

export const GET: RequestHandler = async ({ params }) => {
  const key = params.key;
  if (!/^\d+$/.test(key)) throw error(400, 'Clé d’album invalide');
  try {
    const [albumMeta, trackMeta] = await Promise.all([
      metadata(`/library/metadata/${key}`),
      metadata(`/library/metadata/${key}/children`)
    ]);
    const album = albumMeta[0];
    if (!album) throw new PlexError(404, 'Album introuvable');
    const tracks = trackMeta.map(mapTrack).sort((a, b) => {
      const d = (a.disc ?? 1) - (b.disc ?? 1);
      return d !== 0 ? d : (a.index ?? 0) - (b.index ?? 0);
    });
    return json({ album: mapAlbum(album), tracks });
  } catch (e) {
    plexHttp(e);
  }
};
