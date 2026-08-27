/**
 * GET /api/plex/artist-tracks/<artistKey>?limit=N — pistes d'un artiste, au
 * hasard. Alimente les DJ « même artiste » du lecteur (répliques des Guest DJ
 * PlexAmp) : Twofer (un compagnon après chaque titre) et Groupie (la file
 * continue avec l'artiste). Filtre PMS `artist.id` sur une requête de pistes,
 * vérifié sur ce serveur.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!/^\d+$/.test(params.key)) throw plexHttp(new PlexError(400, 'Artiste invalide'));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
  try {
    const section = await musicSection();
    const res = await pmsFetch(
      `/library/sections/${section.key}/all?type=10&artist.id=${params.key}&sort=random&limit=${limit}`
    );
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const j = (await res.json()) as { MediaContainer?: { Metadata?: RawMeta[] } };
    const tracks = (j.MediaContainer?.Metadata ?? []).map(mapTrack).filter((t) => t.part);
    return json({ tracks });
  } catch (e) {
    plexHttp(e);
  }
};
