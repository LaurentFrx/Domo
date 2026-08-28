/**
 * POST /api/wled/music/beat — heartbeat de L'APPAREIL QUI JOUE la musique :
 *   { key, part, positionMs, playing } — strictement.
 * Les couleurs du rendu sont la palette multicolore du style (music-styles.ts),
 * indépendantes du morceau : rien d'autre ne transite ici.
 *
 * Plus de {stop:true} : l'arrêt découle du mode global (enabled=false, cf.
 * /api/wled/music/mode) ou de la péremption naturelle du heartbeat.
 * Anti-détournement : voir sound-streamer.updateBeat.
 */
import { json, error } from '@sveltejs/kit';
import { updateBeat } from '$lib/server/wled/sound-streamer';
import type { RequestHandler } from './$types';

const PART_RE = /^\/?library\/parts\/\d+\/\d+\/file(\.[A-Za-z0-9]+)?$/;

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw error(400, 'JSON attendu');

  const { key, part, positionMs, playing } = body;
  if (typeof key !== 'string' || !key) throw error(400, 'key manquante');
  // Le part du client porte la signature de flux (`?st=…&k=…`, pour AirPlay)
  // depuis 839f77d — RÉGRESSION VÉCUE : le regex la refusait, chaque battement
  // partait en 400 silencieux et tout le suivi lumineux était mort. On valide
  // et on transmet le CHEMIN seul : l'analyse serveur s'authentifie par token,
  // la signature ne lui sert à rien.
  const partPath = typeof part === 'string' ? part.split('?')[0] : '';
  if (!PART_RE.test(partPath)) throw error(400, 'part invalide');
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0)
    throw error(400, 'positionMs invalide');

  const st = await updateBeat({
    key,
    part: partPath,
    positionMs: Math.round(positionMs),
    playing: playing === true
  });
  return json(st, { headers: { 'cache-control': 'no-store' } });
};
