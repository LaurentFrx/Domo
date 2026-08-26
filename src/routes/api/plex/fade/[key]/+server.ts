/**
 * GET /api/plex/fade/<ratingKey> — analyse de sonie d'une piste pour les
 * fondus enchaînés du lecteur : gain de nivellement + rampes d'enveloppe
 * (intro/outro). Le PMS ne livre les rampes qu'avec `includeLoudnessRamps=1`.
 *
 * Piste jamais analysée (bibliothèque fraîche) : les champs sont null — le
 * lecteur retombe alors sur le fondu de durée fixe. Réponse cachée 1 jour :
 * l'analyse d'un fichier ne change pas tant que le fichier ne change pas.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pmsFetch, PlexError } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import { parseRamp, type TrackFadeInfo } from '$lib/utils/fade';

interface RawStream {
  streamType?: number;
  gain?: string | number;
  startRamp?: string;
  endRamp?: string;
}

export const GET: RequestHandler = async ({ params }) => {
  const key = params.key;
  if (!/^\d+$/.test(key)) throw plexHttp(new PlexError(400, 'Clé de piste invalide'));
  try {
    const res = await pmsFetch(`/library/metadata/${key}?includeLoudnessRamps=1`);
    if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
    const j = (await res.json()) as {
      MediaContainer?: {
        Metadata?: Array<{ Media?: Array<{ Part?: Array<{ Stream?: RawStream[] }> }> }>;
      };
    };
    const streams = (j.MediaContainer?.Metadata ?? [])
      .flatMap((m) => m.Media ?? [])
      .flatMap((md) => md.Part ?? [])
      .flatMap((p) => p.Stream ?? [])
      .filter((s) => s.streamType === 2);
    // Le flux audio porteur de l'analyse (plusieurs éditions : le premier analysé).
    const s = streams.find((st) => st.gain != null || st.endRamp != null) ?? streams[0];
    const gain = s?.gain != null ? Number(s.gain) : NaN;
    const info: TrackFadeInfo = {
      gain: Number.isFinite(gain) ? gain : null,
      startRamp: parseRamp(s?.startRamp),
      endRamp: parseRamp(s?.endRamp)
    };
    return json(info, { headers: { 'cache-control': 'private, max-age=86400' } });
  } catch (e) {
    plexHttp(e);
  }
};
