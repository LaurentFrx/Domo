/**
 * Flux SSE de l'état Zigbee (derrière le guard d'auth par cookie). Remplace la
 * connexion MQTT directe du navigateur → aucun identifiant MQTT côté client (R14).
 * Format `{topic, payload}` identique au flux MQTT d'origine : le store réutilise
 * la même logique de dispatch par topic. Modèle : /api/findmy/stream.
 */
import type { RequestHandler } from './$types';
import { isAuthenticated } from '$lib/server/auth';
import { zigbeeSnapshot, zigbeeSubscribe } from '$lib/server/zigbee-hub';

export const GET: RequestHandler = async ({ cookies }) => {
  if (!isAuthenticated(cookies)) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ka: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (topic: string, payload: string) => {
        try {
          controller.enqueue(
            enc.encode(`event: zigbee\ndata: ${JSON.stringify({ topic, payload })}\n\n`)
          );
        } catch {
          /* flux fermé */
        }
      };
      for (const e of zigbeeSnapshot()) send(e.topic, e.payload); // snapshot = retained
      unsub = zigbeeSubscribe(send); // updates live
      ka = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ka\n\n`));
        } catch {
          /* flux fermé */
        }
      }, 25000);
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
