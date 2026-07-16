/**
 * GET /api/wled/music/timeline?key=<trackKey> — timeline spectrale compacte
 * d'une piste DÉJÀ analysée (volume + battements, 25 fps), pour que l'aperçu
 * de la carte éclairage suive la musique EXACTEMENT comme le ruban (même
 * source de données que le stream sound-sync). 404 si pas encore en cache —
 * le client retentera au heartbeat suivant (l'analyse est déclenchée par
 * /api/wled/music/beat, pas ici).
 */
import { error, json } from '@sveltejs/kit';
import { cachedTimeline, BYTES_PER_FRAME } from '$lib/server/wled/audio-analysis';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const key = url.searchParams.get('key');
  if (!key) throw error(400, 'key manquante');
  const tl = await cachedTimeline(key);
  if (!tl) throw error(404, 'piste non analysée');

  // Volume (o.16) + battement (o.17) par trame — 2 octets/trame, ~12 Ko / 4 min.
  const vol = Buffer.alloc(tl.frames);
  const peak = Buffer.alloc(tl.frames);
  for (let f = 0; f < tl.frames; f++) {
    vol[f] = tl.data[f * BYTES_PER_FRAME + 16];
    peak[f] = tl.data[f * BYTES_PER_FRAME + 17];
  }
  return json(
    { fps: tl.fps, frames: tl.frames, vol: vol.toString('base64'), peak: peak.toString('base64') },
    { headers: { 'cache-control': 'private, max-age=3600' } }
  );
};
