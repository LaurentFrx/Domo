/**
 * POST /api/plex/playlists/<key>/items { keys: ["123", …] } — ajoute des
 * titres/albums (ratingKeys) à une playlist CLASSIQUE. Plex refuse sur une
 * playlist intelligente (smart) — l'UI n'expose pas ce cas.
 */
import { error, json } from '@sveltejs/kit';
import { machineId, pmsFetch, PlexError } from '$lib/server/plex';
import { mapPlaylist, plexHttp, type RawMeta } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { Metadata?: RawMeta[] };
}

export const POST: RequestHandler = async ({ params, request }) => {
  if (!/^\d+$/.test(params.key)) throw error(400, 'Clé de playlist invalide');
  let body: { keys?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, 'JSON invalide');
  }
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  if (keys.length === 0 || keys.some((k) => !/^\d+$/.test(k))) {
    throw error(400, 'Liste de titres invalide');
  }
  try {
    const id = await machineId();
    const uri = `server://${id}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;
    const res = await pmsFetch(`/playlists/${params.key}/items?uri=${encodeURIComponent(uri)}`, {
      method: 'PUT'
    });
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const updated = ((await res.json()) as Container).MediaContainer?.Metadata?.[0];
    return json({ ok: true, playlist: updated ? mapPlaylist(updated) : null });
  } catch (e) {
    plexHttp(e);
  }
};
