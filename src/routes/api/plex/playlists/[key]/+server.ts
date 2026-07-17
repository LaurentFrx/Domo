/**
 * Une playlist audio Plex.
 *   GET    /api/plex/playlists/<key> → { playlist, tracks } (tracks avec playlistItemId)
 *   PUT    /api/plex/playlists/<key> { title } → renommage
 *   DELETE /api/plex/playlists/<key> → suppression de la playlist
 *          (les FICHIERS ne sont jamais touchés — seule la liste disparaît)
 */
import { error, json } from '@sveltejs/kit';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { mapPlaylist, mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { Metadata?: RawMeta[] };
}

function assertKey(key: string): void {
  if (!/^\d+$/.test(key)) throw error(400, 'Clé de playlist invalide');
}

export const GET: RequestHandler = async ({ params }) => {
  assertKey(params.key);
  try {
    const [plRes, itemsRes] = await Promise.all([
      pmsFetch(`/playlists/${params.key}`),
      pmsFetch(`/playlists/${params.key}/items`)
    ]);
    if (!plRes.ok)
      throw new PlexError(plRes.status === 404 ? 404 : 502, `Plex: HTTP ${plRes.status}`);
    if (!itemsRes.ok) throw new PlexError(502, `Plex: HTTP ${itemsRes.status}`);
    const pl = ((await plRes.json()) as Container).MediaContainer?.Metadata?.[0];
    if (!pl) throw new PlexError(404, 'Playlist introuvable');
    const items = ((await itemsRes.json()) as Container).MediaContainer?.Metadata ?? [];
    return json({ playlist: mapPlaylist(pl), tracks: items.map(mapTrack) });
  } catch (e) {
    plexHttp(e);
  }
};

export const PUT: RequestHandler = async ({ params, request }) => {
  assertKey(params.key);
  let body: { title?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, 'JSON invalide');
  }
  const title = (body.title ?? '').trim();
  if (!title || title.length > 120) throw error(400, 'Titre invalide');
  try {
    const res = await pmsFetch(`/playlists/${params.key}?title=${encodeURIComponent(title)}`, {
      method: 'PUT'
    });
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (e) {
    plexHttp(e);
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  assertKey(params.key);
  try {
    const res = await pmsFetch(`/playlists/${params.key}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (e) {
    plexHttp(e);
  }
};
