/**
 * Une LIGNE d'une playlist classique (playlistItemID).
 *   DELETE /api/plex/playlists/<key>/items/<itemId> → retire la ligne
 *   PUT    /api/plex/playlists/<key>/items/<itemId> { after: "<itemId>" | null }
 *          → déplace la ligne (null = tout en haut)
 */
import { error, json } from '@sveltejs/kit';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

function assertIds(key: string, itemId: string): void {
  if (!/^\d+$/.test(key) || !/^\d+$/.test(itemId)) throw error(400, 'Identifiants invalides');
}

export const DELETE: RequestHandler = async ({ params }) => {
  assertIds(params.key, params.itemId);
  try {
    const res = await pmsFetch(`/playlists/${params.key}/items/${params.itemId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (e) {
    plexHttp(e);
  }
};

export const PUT: RequestHandler = async ({ params, request }) => {
  assertIds(params.key, params.itemId);
  let body: { after?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, 'JSON invalide');
  }
  const after = body.after ?? null;
  if (after !== null && !/^\d+$/.test(String(after))) throw error(400, 'Paramètre after invalide');
  try {
    const res = await pmsFetch(
      `/playlists/${params.key}/items/${params.itemId}/move${after ? `?after=${after}` : ''}`,
      { method: 'PUT' }
    );
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (e) {
    plexHttp(e);
  }
};
