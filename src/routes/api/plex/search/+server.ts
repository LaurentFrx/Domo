/**
 * GET /api/plex/search?q=… — recherche globale (artistes, albums, pistes) via
 * /hubs/search du PMS. Réponse : { artists, albums, tracks } (formes compactes).
 */
import { error, json } from '@sveltejs/kit';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { mapAlbum, mapArtist, mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

interface HubsResponse {
  MediaContainer?: { Hub?: Array<{ type?: string; Metadata?: RawMeta[] }> };
}

export const GET: RequestHandler = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return json({ artists: [], albums: [], tracks: [] });
  try {
    const res = await pmsFetch(`/hubs/search?query=${encodeURIComponent(q)}&limit=10`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const hubs = ((await res.json()) as HubsResponse).MediaContainer?.Hub ?? [];
    const of = (type: string): RawMeta[] => hubs.find((h) => h.type === type)?.Metadata ?? [];
    return json({
      artists: of('artist').map(mapArtist),
      albums: of('album').map(mapAlbum),
      tracks: of('track').map(mapTrack)
    });
  } catch (e) {
    plexHttp(e);
  }
};

export const fallback: RequestHandler = () => {
  throw error(405, 'Méthode non autorisée');
};
