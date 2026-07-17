/**
 * POST /api/wled/music/mode — état PARTAGÉ du mode Musique (un seul ruban,
 * un seul état, tous les appareils).
 *   body { enabled?, style? } → met à jour, persiste, diffuse (SSE) et
 *   applique le rendu au ruban côté serveur (palette multicolore du style).
 * GET — snapshot de l'état (debug / premier rendu sans SSE).
 */
import { json, error } from '@sveltejs/kit';
import { musicModeState, setMode } from '$lib/server/wled/music-mode';
import { beatStatus } from '$lib/server/wled/sound-streamer';
import { WLED_MUSIC_STYLES } from '$lib/wled/music-styles';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  return json(
    { ...musicModeState(), ...beatStatus() },
    { headers: { 'cache-control': 'no-store' } }
  );
};

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw error(400, 'JSON attendu');

  const patch: { enabled?: boolean; style?: string } = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.style === 'string') {
    if (!WLED_MUSIC_STYLES.some((s) => s.key === body.style)) throw error(400, 'style inconnu');
    patch.style = body.style;
  }
  if (!Object.keys(patch).length) throw error(400, 'aucun champ valide');

  // POST /mode = GESTE UTILISATEUR (chip Musique, choix de style) : le rendu
  // a le droit d'ALLUMER le ruban — taper une scène doit produire de la lumière.
  // `quiet` : désactivation qui ACCOMPAGNE une commande manuelle (releaseControl)
  // → pas de repli statique (la commande pose son propre état, pas de course).
  const st = await setMode(patch, beatStatus().playing, {
    userGesture: true,
    quiet: body.quiet === true
  });
  return json(st, { headers: { 'cache-control': 'no-store' } });
};
