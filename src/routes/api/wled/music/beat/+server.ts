/**
 * POST /api/wled/music/beat — pilotage du stream sound-sync (éclairage
 * audio-réactif). Le client (mode Musique, style réactif) envoie :
 *   { key, part, positionMs, playing }  → heartbeat / (re)calage
 *   { stop: true }                      → arrêt du stream
 * Réponse : { ready, analyzing } — `analyzing` le temps de la première analyse
 * spectrale d'une piste (quelques secondes, une seule fois par morceau).
 */
import { json, error } from '@sveltejs/kit';
import { stopBeat, updateBeat } from '$lib/server/wled/sound-streamer';
import type { RequestHandler } from './$types';

const PART_RE = /^\/?library\/parts\/\d+\/\d+\/file(\.[A-Za-z0-9]+)?$/;

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw error(400, 'JSON attendu');

  if (body.stop === true) {
    stopBeat();
    return json({ ready: false, analyzing: false });
  }

  const { key, part, positionMs, playing } = body;
  if (typeof key !== 'string' || !key) throw error(400, 'key manquante');
  if (typeof part !== 'string' || !PART_RE.test(part)) throw error(400, 'part invalide');
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0)
    throw error(400, 'positionMs invalide');

  const status = await updateBeat({
    key,
    part,
    positionMs: Math.round(positionMs),
    playing: playing === true
  });
  return json(status, { headers: { 'cache-control': 'no-store' } });
};
