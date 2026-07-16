/**
 * GET /api/wled/music/live — SSE : canal temps réel UNIQUE du mode Musique.
 * À la connexion : snapshot { enabled, style, colors, key, playing, analyzing,
 * level, peak }. Ensuite : événements partiels (état) + niveau sonore 12,5 Hz
 * pendant la lecture (poussé par le tick du streamer). Keepalive 15 s.
 * TOUS les appareils le consomment (chip, styles, légende, barre animée) —
 * plus aucun flag local. Pattern SSE identique au proxy Find My (Caddy-safe).
 */
import type { RequestHandler } from './$types';
import { isAuthenticated } from '$lib/server/auth';
import { musicModeState, subscribeLive, type LiveEvent } from '$lib/server/wled/music-mode';
import { beatStatus } from '$lib/server/wled/sound-streamer';

export const GET: RequestHandler = async ({ cookies }) => {
  if (!isAuthenticated(cookies)) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ka: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: LiveEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* flux fermé */
        }
      };
      const bs = beatStatus();
      send({
        ...musicModeState(),
        key: bs.key,
        playing: bs.playing,
        analyzing: false,
        level: 0,
        peak: 0
      });
      unsub = subscribeLive(send);
      ka = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ka\n\n`));
        } catch {
          /* flux fermé */
        }
      }, 15000);
    },
    cancel() {
      if (unsub) unsub();
      if (ka) clearInterval(ka);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    }
  });
};
