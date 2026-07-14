/**
 * Appairage plex.tv/link (jamais d'extraction du token serveur) :
 *   POST /api/plex/link        → crée un PIN { id, code } (à saisir sur plex.tv/link)
 *   GET  /api/plex/link?id=N   → poll { linked } ; le token est stocké côté serveur
 *   DELETE /api/plex/link      → oublie l'appairage (data/plex-auth.json)
 */
import { error, json } from '@sveltejs/kit';
import { checkPin, createPin, unlink } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try {
    return json(await createPin());
  } catch (e) {
    plexHttp(e);
  }
};

export const GET: RequestHandler = async ({ url }) => {
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw error(400, 'Paramètre id invalide');
  try {
    return json({ linked: await checkPin(id) });
  } catch (e) {
    plexHttp(e);
  }
};

export const DELETE: RequestHandler = async () => {
  await unlink();
  return json({ ok: true });
};
