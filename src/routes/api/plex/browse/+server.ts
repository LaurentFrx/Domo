/**
 * GET /api/plex/browse — navigation dans la bibliothèque musicale.
 *   ?view=recent                   → albums récemment ajoutés
 *   ?view=albums&offset=&limit=    → tous les albums (tri alphabétique), paginé
 *   ?view=artists                  → tous les artistes (tri alphabétique)
 *   ?view=artist&key=<ratingKey>   → les albums d'un artiste
 * Réponse : { items, total } (formes compactes de plex-map).
 */
import { error, json } from '@sveltejs/kit';
import { musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { mapAlbum, mapArtist, plexHttp, type RawMeta } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { totalSize?: number; size?: number; Metadata?: RawMeta[] };
}

async function fetchContainer(path: string): Promise<{ items: RawMeta[]; total: number }> {
  const res = await pmsFetch(path);
  if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
  const j = (await res.json()) as Container;
  const items = j.MediaContainer?.Metadata ?? [];
  return { items, total: j.MediaContainer?.totalSize ?? j.MediaContainer?.size ?? items.length };
}

export const GET: RequestHandler = async ({ url }) => {
  const view = url.searchParams.get('view') ?? 'albums';
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const paging = `X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${limit}`;

  try {
    const section = await musicSection();
    switch (view) {
      case 'recent': {
        const { items, total } = await fetchContainer(
          `/library/sections/${section.key}/all?type=9&sort=addedAt:desc&${paging}`
        );
        return json({ items: items.map(mapAlbum), total });
      }
      case 'albums': {
        const { items, total } = await fetchContainer(
          `/library/sections/${section.key}/all?type=9&sort=titleSort&${paging}`
        );
        return json({ items: items.map(mapAlbum), total });
      }
      case 'artists': {
        const { items, total } = await fetchContainer(
          `/library/sections/${section.key}/all?type=8&sort=titleSort&${paging}`
        );
        return json({ items: items.map(mapArtist), total });
      }
      case 'artist': {
        const key = url.searchParams.get('key') ?? '';
        if (!/^\d+$/.test(key)) throw error(400, 'Paramètre key invalide');
        const { items, total } = await fetchContainer(`/library/metadata/${key}/children`);
        return json({ items: items.map(mapAlbum), total });
      }
      default:
        throw error(400, `view inconnue : ${view}`);
    }
  } catch (e) {
    plexHttp(e);
  }
};
