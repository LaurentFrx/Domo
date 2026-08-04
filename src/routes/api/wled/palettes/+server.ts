/**
 * GET /api/wled/palettes → couleurs réelles des palettes du module.
 *
 * Endpoint À PART du proxy `/api/wled/[...path]` pour deux raisons :
 *   1. `/json/palx` est PAGINÉ (9 pages sur ce firmware) et le proxy reconstruit
 *      l'URL depuis une liste fermée, sans query string — il ne saurait pas
 *      demander la page N. L'agrégation se fait donc ici, côté serveur.
 *   2. le résultat ne change qu'à un flashage : le mettre en cache ici évite 9
 *      allers-retours vers un module à -73 dBm chaque fois qu'on ouvre /pieces.
 *
 * Le client s'en sert pour PEINDRE l'aperçu ; s'il échoue, l'aperçu retombe sur
 * sa table de dégradés écrite à la main — dégradé de service, jamais d'écran
 * cassé (la carte est en service).
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { fetchPalettes } from '$lib/server/wled/palettes';
import { wledPalx } from '$lib/server/wled-mock';
import type { RequestHandler } from './$types';

/** Même aiguillage mock/live que le proxy — une seule variable fait foi. */
function liveBase(): string | null {
  const u = (env.WLED_URL || '').trim().replace(/\/+$/, '');
  if (!u || u.toLowerCase() === 'mock') return null;
  return u;
}

export const GET: RequestHandler = async () => {
  const base = liveBase();
  if (!base) {
    return json(
      { palettes: wledPalx() },
      { headers: { 'x-wled-source': 'mock', 'cache-control': 'no-store' } }
    );
  }

  try {
    const palettes = await fetchPalettes(base);
    return json(
      { palettes },
      { headers: { 'x-wled-source': 'live', 'cache-control': 'no-store' } }
    );
  } catch {
    // Le module est muet : on le dit franchement plutôt que de servir un
    // catalogue vide, que le client prendrait pour « ce ruban n'a pas de
    // couleurs » et peindrait en gris.
    throw error(504, 'WLED: palettes illisibles');
  }
};
