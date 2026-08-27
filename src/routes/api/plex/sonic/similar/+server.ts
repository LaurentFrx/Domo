/**
 * POST /api/plex/sonic/similar — pistes soniquement proches d'une piste.
 * Corps : { key, limit?, exclude?: string[] } (POST : la liste d'exclusion —
 * la file de lecture — peut dépasser ce qu'une URL supporte).
 *
 * Réponse : { tracks } triées par similarité décroissante — les clés voisines
 * viennent de l'index maison (data/sonic.db), les métadonnées du PMS (requête
 * groupée /library/metadata/k1,k2,…). 404 : piste non analysée ou analyse
 * absente — les DJ soniques se replient sur une station.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';
import { sonicSimilar } from '$lib/server/sonic';

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as {
    key?: string;
    limit?: number;
    exclude?: string[];
  };
  if (!body.key || !/^\d+$/.test(body.key)) throw plexHttp(new PlexError(400, 'Clé invalide'));
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const exclude = new Set((body.exclude ?? []).map(String));
  const keys = sonicSimilar(body.key, exclude, limit);
  if (!keys) throw plexHttp(new PlexError(404, 'Piste non analysée (analyse sonique maison)'));
  if (keys.length === 0) return json({ tracks: [] });
  try {
    const res = await pmsFetch(`/library/metadata/${keys.join(',')}`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const j = (await res.json()) as { MediaContainer?: { Metadata?: RawMeta[] } };
    const byKey = new Map((j.MediaContainer?.Metadata ?? []).map(mapTrack).map((t) => [t.key, t]));
    // L'ordre de similarité fait foi (le PMS ne garantit pas le sien) ; les
    // clés que le PMS ne connaît plus (piste supprimée) tombent simplement.
    const tracks = keys.map((k) => byKey.get(k)).filter((t) => t && t.part);
    return json({ tracks });
  } catch (e) {
    plexHttp(e);
  }
};
