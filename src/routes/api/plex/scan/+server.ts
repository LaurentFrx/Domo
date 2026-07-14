/**
 * POST /api/plex/scan — lance une analyse de la bibliothèque musicale
 * (bouton « Analyser » du mode Gérer ; l'upload déclenche déjà son scan partiel).
 */
import { json } from '@sveltejs/kit';
import { musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try {
    const section = await musicSection();
    const res = await pmsFetch(`/library/sections/${section.key}/refresh`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    return json({ ok: true });
  } catch (e) {
    plexHttp(e);
  }
};
