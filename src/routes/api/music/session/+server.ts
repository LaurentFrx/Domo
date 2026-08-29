/**
 * Session d'écoute de la maison — un seul appareil joue à la fois.
 *
 *   GET  /api/music/session  → SSE : qui joue, en direct (snapshot immédiat)
 *   POST /api/music/session  → { action: 'claim' | 'ping' | 'release',
 *                                deviceId, kind?, title? }
 *
 * Le NOM affiché est composé côté serveur (« iPad de Laurent ») : le client
 * envoie seulement le type d'appareil, l'identité vient du cookie de session —
 * un navigateur ne s'annonce pas au nom de quelqu'un d'autre.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAuthenticated } from '$lib/server/auth';
import {
  claim,
  ping,
  prenomFromEmail,
  release,
  sessionState,
  subscribeSession,
  type MusicSession
} from '$lib/server/music-session';

/** Types d'appareil acceptés (liste fermée : c'est un libellé, pas du texte libre). */
const KINDS = new Set(['iPhone', 'iPad', 'Mac', 'Android', 'Ordinateur', 'Navigateur']);

export const GET: RequestHandler = async ({ cookies }) => {
  if (!isAuthenticated(cookies)) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let ka: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (s: MusicSession | null) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(s ?? { deviceId: null })}\n\n`));
        } catch {
          /* flux fermé */
        }
      };
      send(sessionState());
      unsub = subscribeSession(send);
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

export const POST: RequestHandler = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw error(400, 'JSON attendu');
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) throw error(400, 'deviceId invalide');
  const action = body.action;
  const title = typeof body.title === 'string' ? body.title.slice(0, 120) : '';

  if (action === 'release') {
    release(deviceId);
    return json({ ok: true });
  }
  if (action === 'ping') {
    return json(ping(deviceId, title) ?? { deviceId: null });
  }
  if (action === 'claim') {
    const kindRaw = typeof body.kind === 'string' ? body.kind : '';
    const kind = KINDS.has(kindRaw) ? kindRaw : 'Navigateur';
    const prenom = prenomFromEmail(locals.user?.email);
    return json(claim(deviceId, prenom ? `${kind} de ${prenom}` : kind, title));
  }
  throw error(400, 'action inconnue');
};
