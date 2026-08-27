/**
 * GET /api/plex/stream/library/parts/<id>/<ts>/file.<ext> — proxy du flux audio
 * en LECTURE DIRECTE (le fichier tel quel, pas de transcodage : bibliothèque
 * mp3/m4a/flac, tous lus nativement par iOS).
 *
 * Le support des requêtes Range (206) est OBLIGATOIRE : c'est ainsi que
 * l'élément <audio> de Safari/iOS fait du seek. On relaie l'en-tête Range vers
 * le PMS et on restitue status + en-têtes de contenu tels quels, corps streamé.
 */
import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { pmsFetch, pmsQueryIdentity } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import type { RequestHandler } from './$types';

const PART_RE = /^library\/parts\/\d+\/\d+\/file(\.[A-Za-z0-9]+)?$/;
const PASSTHROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

/**
 * Formats que la pile AVFoundation d'un récepteur AirPlay ne lit PAS en
 * progressif. Constaté avec la chaîne CEOL sur un FLAC : le récepteur vient
 * chercher le fichier (4 requêtes en 1,5 s, journal [stream]) puis le
 * recrache — session AirPlay parfaite, piste « vide ». WebKit sur l'iPhone a
 * son propre décodeur FLAC ; AppleCoreMedia côté récepteur, non.
 */
const RECEIVER_TRANSCODE_RE = /\.(flac|ogg|opus|wma)$/i;

export const GET: RequestHandler = async ({ params, request, url, cookies }) => {
  const part = params.part;
  if (!PART_RE.test(part)) throw error(400, 'Chemin de flux non autorisé');

  // Pas de cookie de session = un récepteur AirPlay venu avec l'URL signée
  // (le hook a déjà vérifié la signature, `k` compris) : les formats qu'il ne
  // sait pas décoder partent en transcodage MP3 côté PMS. L'utilisateur sur
  // l'app (cookie) garde toujours la lecture directe, FLAC compris.
  const rk = url.searchParams.get('k');
  if (
    !cookies.get(SESSION_COOKIE_NAME) &&
    rk &&
    /^\d+$/.test(rk) &&
    RECEIVER_TRANSCODE_RE.test(part)
  ) {
    return transcodeForReceiver(rk);
  }

  const range = request.headers.get('range');
  try {
    // timeoutMs: 0 → pas d'AbortSignal : un morceau se streame plus de 10 s.
    const upstream = await pmsFetch(`/${part}`, {
      timeoutMs: 0,
      headers: range ? { range } : {}
    });
    if (!upstream.ok && upstream.status !== 206) {
      // Le 404 est RELAYÉ tel quel : c'est lui qui permet au lecteur de dire
      // « fichier disparu » (et de sauter la piste) plutôt que « Plex en panne ».
      throw error(upstream.status === 404 ? 404 : 502, `Plex stream: HTTP ${upstream.status}`);
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

/**
 * Transcodage universel du PMS → MP3 320 progressif, le format que tout
 * récepteur AirPlay sait lire. Particularités du transcodeur (bisectées) :
 * token ET identité exigés dans la QUERY, `hasMDE=1` obligatoire. Session
 * UNIQUE PAR REQUÊTE : avec une session stable par piste, deux récepteurs qui
 * se relaient (CEOL → Apple TV → CEOL) tuaient mutuellement leur transcodage —
 * paires de requêtes à 1 s d'écart dans le journal, « son une fraction de
 * seconde puis plus rien » côté enceinte. Chaque connexion a désormais son
 * transcodeur ; le PMS moissonne celui dont la connexion se ferme. Les Range
 * sont ignorés (flux non seekable, comme une webradio) — AVFoundation s'en
 * accommode ; le seek AirPlay sur un FLAC transcodé reste sans effet.
 */
async function transcodeForReceiver(ratingKey: string): Promise<Response> {
  try {
    const qs = new URLSearchParams({
      hasMDE: '1',
      path: `/library/metadata/${ratingKey}`,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'http',
      audioCodec: 'mp3',
      musicBitrate: '320',
      directPlay: '0',
      directStream: '0',
      session: `airplay-${ratingKey}-${randomUUID().slice(0, 8)}`,
      ...(await pmsQueryIdentity())
    });
    const upstream = await pmsFetch(`/music/:/transcode/universal/start.mp3?${qs}`, {
      timeoutMs: 0
    });
    if (!upstream.ok) throw error(502, `Plex transcode: HTTP ${upstream.status}`);
    console.log(`[stream] transcodage MP3 pour récepteur AirPlay (piste ${ratingKey})`);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        'cache-control': 'no-store',
        'accept-ranges': 'none'
      }
    });
  } catch (e) {
    plexHttp(e);
  }
}
