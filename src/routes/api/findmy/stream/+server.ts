import type { RequestHandler } from './$types';
import { isAuthenticated } from '$lib/server/auth';
import { findmySnapshot, findmySubscribe } from '$lib/server/findmy';

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
            enc.encode(`event: findmy\ndata: ${JSON.stringify({ topic, payload })}\n\n`)
          );
        } catch {
          /* flux fermé */
        }
      };
      for (const e of findmySnapshot()) send(e.topic, e.payload); // snapshot = remplace le retained
      unsub = findmySubscribe(send); // updates live
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
