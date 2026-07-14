/**
 * GET /api/plex/stream/library/parts/<id>/<ts>/file.<ext> — proxy du flux audio
 * en LECTURE DIRECTE (le fichier tel quel, pas de transcodage : bibliothèque
 * mp3/m4a/flac, tous lus nativement par iOS).
 *
 * Le support des requêtes Range (206) est OBLIGATOIRE : c'est ainsi que
 * l'élément <audio> de Safari/iOS fait du seek. On relaie l'en-tête Range vers
 * le PMS et on restitue status + en-têtes de contenu tels quels, corps streamé.
 */
import { error } from '@sveltejs/kit';
import { pmsFetch } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import type { RequestHandler } from './$types';

const PART_RE = /^library\/parts\/\d+\/\d+\/file(\.[A-Za-z0-9]+)?$/;
const PASSTHROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export const GET: RequestHandler = async ({ params, request }) => {
  const part = params.part;
  if (!PART_RE.test(part)) throw error(400, 'Chemin de flux non autorisé');

  const range = request.headers.get('range');
  try {
    // timeoutMs: 0 → pas d'AbortSignal : un morceau se streame plus de 10 s.
    const upstream = await pmsFetch(`/${part}`, {
      timeoutMs: 0,
      headers: range ? { range } : {}
    });
    if (!upstream.ok && upstream.status !== 206) {
      throw error(502, `Plex stream: HTTP ${upstream.status}`);
    }
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const k of PASSTHROUGH) {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    plexHttp(e);
  }
};
