/**
 * GET /api/plex/station/<id>?limit=N — pistes d'une STATION radio du PMS
 * (les « DJ » de PlexAmp : 1 Library, 2 Time Travel, 3 Random Album,
 * 8 Deep Cuts). Une station n'est pas un endpoint lisible : les clients Plex
 * créent une playQueue depuis son URI, puis élargissent la fenêtre — le POST
 * initial ne rend qu'une vingtaine de lignes, c'est le GET window=N qui donne
 * la suite (vérifié sur ce PMS : POST size 21, GET window=120 → 121).
 *
 * Le smart shuffle du serveur pondère par notes/écoutes (SmartShuffleMusic) ;
 * pas d'analyse sonique sur ce PMS (RPi4) — les stations n'en ont pas besoin.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { machineId, musicSection, pmsFetch, PlexError } from '$lib/server/plex';
import { mapTrack, plexHttp, type RawMeta } from '$lib/server/plex-map';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!/^\d+$/.test(params.id)) throw plexHttp(new PlexError(400, 'Station invalide'));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
  try {
    const [mid, section] = await Promise.all([machineId(), musicSection()]);
    const uri = encodeURIComponent(
      `server://${mid}/com.plexapp.plugins.library/library/sections/${section.key}/stations/${params.id}`
    );
    const created = await pmsFetch(`/playQueues?type=audio&uri=${uri}&shuffle=0&repeat=0`, {
      method: 'POST'
    });
    if (!created.ok) throw new PlexError(502, `Plex: HTTP ${created.status}`);
    const pq = (await created.json()) as { MediaContainer?: { playQueueID?: number } };
    const pqid = pq.MediaContainer?.playQueueID;
    if (!pqid) throw new PlexError(502, 'Plex : playQueue non créée pour cette station');
    const res = await pmsFetch(`/playQueues/${pqid}?window=${limit}&includeChapters=0`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const j = (await res.json()) as { MediaContainer?: { Metadata?: RawMeta[] } };
    const tracks = (j.MediaContainer?.Metadata ?? [])
      .map(mapTrack)
      .filter((t) => t.part)
      .slice(0, limit);
    return json({ tracks });
  } catch (e) {
    plexHttp(e);
  }
};
