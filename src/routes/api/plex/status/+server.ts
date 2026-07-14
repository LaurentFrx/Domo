/**
 * GET /api/plex/status — état de l'intégration Plex pour la page Musique :
 * configured (PLEX_URL posé) / linked (token d'appairage présent) / online
 * (PMS joignable), + identité du serveur et de la bibliothèque musicale.
 * `needsRelink` passe à true si le token a été révoqué côté plex.tv.
 */
import { json } from '@sveltejs/kit';
import { PlexError, isLinked, linkedAt, musicSection, plexBase, pmsFetch } from '$lib/server/plex';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const configured = !!plexBase();
  const linked = configured && (await isLinked());
  if (!configured || !linked) {
    return json({ configured, linked, online: false, needsRelink: false });
  }
  try {
    const res = await pmsFetch('/');
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const j = (await res.json()) as {
      MediaContainer?: { friendlyName?: string; version?: string };
    };
    const section = await musicSection();
    return json({
      configured,
      linked,
      online: true,
      needsRelink: false,
      linkedAt: await linkedAt(),
      server: {
        name: j.MediaContainer?.friendlyName ?? 'Plex',
        version: j.MediaContainer?.version ?? null
      },
      section: { key: section.key, title: section.title }
    });
  } catch (e) {
    const needsRelink = e instanceof PlexError && e.status === 401;
    return json({
      configured,
      linked: !needsRelink,
      online: false,
      needsRelink,
      error: e instanceof Error ? e.message : 'Erreur inconnue'
    });
  }
};
