/**
 * Playlists musicales Plex.
 *   GET  /api/plex/playlists → liste des playlists audio (classiques + intelligentes)
 *   POST /api/plex/playlists → création :
 *     { title, keys: ["123", …] }   playlist CLASSIQUE depuis des ratingKeys
 *     { title, smart: SmartRules }  playlist INTELLIGENTE (smart=1, requête de
 *                                   filtres — Plex la met à jour tout seul)
 */
import { error, json } from '@sveltejs/kit';
import { machineId, musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { mapPlaylist, plexHttp, type RawMeta } from '$lib/server/plex-map';
import { smartQuery, type SmartRules } from '$lib/server/plex-smart';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { Metadata?: RawMeta[] };
}

export const GET: RequestHandler = async () => {
  try {
    const res = await pmsFetch('/playlists?playlistType=audio');
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const items = ((await res.json()) as Container).MediaContainer?.Metadata ?? [];
    return json({
      items: items.filter((m) => (m.playlistType ?? 'audio') === 'audio').map(mapPlaylist)
    });
  } catch (e) {
    plexHttp(e);
  }
};

export const POST: RequestHandler = async ({ request }) => {
  let body: { title?: string; keys?: unknown; smart?: SmartRules };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, 'JSON invalide');
  }
  const title = (body.title ?? '').trim();
  if (!title || title.length > 120) throw error(400, 'Titre de playlist invalide');

  try {
    const id = await machineId();
    let path: string;
    if (body.smart) {
      const section = await musicSection();
      const uri = `server://${id}/com.plexapp.plugins.library/library/sections/${section.key}/all?${smartQuery(body.smart)}`;
      path = `/playlists?type=audio&smart=1&title=${encodeURIComponent(title)}&uri=${encodeURIComponent(uri)}`;
    } else {
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      if (keys.length === 0 || keys.some((k) => !/^\d+$/.test(k))) {
        throw error(400, 'Liste de titres invalide');
      }
      const uri = `server://${id}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;
      path = `/playlists?type=audio&smart=0&title=${encodeURIComponent(title)}&uri=${encodeURIComponent(uri)}`;
    }
    const res = await pmsFetch(path, { method: 'POST' });
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const created = ((await res.json()) as Container).MediaContainer?.Metadata?.[0];
    if (!created) throw new PlexError(502, 'Plex: playlist créée mais réponse vide');
    return json({ playlist: mapPlaylist(created) });
  } catch (e) {
    plexHttp(e);
  }
};
