/**
 * GET /api/wled/leds — SSE : les vraies couleurs de CHAQUE LED du ruban, en
 * direct (relais du flux « live view » du module, cf. server/wled/live-leds).
 *
 * Chaque événement porte une trame en base64 : en-tête 'L' + version, puis un
 * triplet RGB par LED dans l'ordre physique. Le client découpe par segment
 * (ligne 1 = LED 0-51, ligne 2 = LED 52-101) — il connaît les bornes par
 * `wled.segments`.
 *
 * Le module n'est sollicité que tant qu'au moins un navigateur écoute : la
 * connexion montante est unique et partagée, ouverte au premier abonné et
 * refermée au dernier.
 */
import type { RequestHandler } from './$types';
import { isAuthenticated } from '$lib/server/auth';
import { liveLedsAvailable, subscribeLeds } from '$lib/server/wled/live-leds';

export const GET: RequestHandler = async ({ cookies }) => {
  if (!isAuthenticated(cookies)) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ka: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (line: string) => {
        try {
          controller.enqueue(enc.encode(line));
        } catch {
          /* flux fermé */
        }
      };
      // Module en mock ou non configuré : on le DIT, le client retombe alors
      // sur son rendu calculé au lieu d'attendre des trames qui ne viendront pas.
      if (!liveLedsAvailable()) {
        send(`event: unavailable\ndata: {}\n\n`);
      } else {
        unsub = subscribeLeds((frame) => {
          send(`data: ${Buffer.from(frame).toString('base64')}\n\n`);
        });
      }
      ka = setInterval(() => send(`: ka\n\n`), 15000);
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
