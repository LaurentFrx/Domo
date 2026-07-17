/**
 * POST /api/plex/smart { rules: SmartRules } — exécute une requête de mix
 * intelligent SANS créer de playlist : renvoie les pistes correspondantes
 * (lecture immédiate des presets « Mix intelligents » et aperçu du
 * constructeur avant enregistrement).
 */
import { error, json } from '@sveltejs/kit';
import { musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';
import { smartQuery, type SmartRules } from '$lib/server/plex-smart';
import type { RequestHandler } from './$types';

interface Container {
  MediaContainer?: { totalSize?: number; size?: number; Metadata?: RawMeta[] };
}

export const POST: RequestHandler = async ({ request }) => {
  let body: { rules?: SmartRules };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, 'JSON invalide');
  }
  if (!body.rules || typeof body.rules !== 'object') throw error(400, 'Règles manquantes');
  try {
    const section = await musicSection();
    const res = await pmsFetch(`/library/sections/${section.key}/all?${smartQuery(body.rules)}`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const mc = ((await res.json()) as Container).MediaContainer;
    const items = mc?.Metadata ?? [];
    return json({ tracks: items.map(mapTrack), total: mc?.totalSize ?? mc?.size ?? items.length });
  } catch (e) {
    plexHttp(e);
  }
};
