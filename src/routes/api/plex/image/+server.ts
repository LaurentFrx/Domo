/**
 * GET /api/plex/image?path=/library/metadata/<id>/thumb/<ts>&size=300
 * Proxy des pochettes via le transcodeur photo du PMS (redimensionnées serveur).
 * Liste fermée de chemins (thumb/art de métadonnées uniquement) + cache long :
 * les pochettes sont immuables (le <ts> change si l'image change).
 */
import { error } from '@sveltejs/kit';
import { pmsFetch } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

const PATH_RE = /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

export const GET: RequestHandler = async ({ url, setHeaders }) => {
  const path = url.searchParams.get('path') ?? '';
  if (!PATH_RE.test(path)) throw error(400, 'Chemin d’image non autorisé');
  const size = Math.min(1200, Math.max(64, Number(url.searchParams.get('size')) || 300));

  try {
    const upstream = await pmsFetch(
      `/photo/:/transcode?width=${size}&height=${size}&minSize=1&upscale=1&url=${encodeURIComponent(path)}`,
      { timeoutMs: 15_000 }
    );
    if (!upstream.ok) throw error(502, `Plex image: HTTP ${upstream.status}`);
    setHeaders({
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': 'private, max-age=604800, immutable'
    });
    return new Response(upstream.body);
  } catch (e) {
    plexHttp(e);
  }
};
