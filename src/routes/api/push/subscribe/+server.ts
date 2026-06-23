/**
 * Abonnement Web Push (derrière le guard d'auth par cookie de hooks.server.ts).
 *
 * GET  → clé publique VAPID (nécessaire au client pour s'abonner) + nb d'abonnés.
 * POST → enregistre/retire un abonnement Push du navigateur.
 *
 * Aucun secret exposé : seule la clé PUBLIQUE est renvoyée ; la clé privée reste
 * server-only (web-push). Les abonnements vivent dans data/push-subscriptions.json.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  addSubscription,
  removeSubscription,
  publicKey,
  subscriptionCount,
  sendPush
} from '$lib/server/monitor/push';

export const GET: RequestHandler = async () => {
  return json({
    vapidPublicKey: publicKey(),
    enabled: publicKey() !== null,
    count: subscriptionCount()
  });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
    keys?: unknown;
    unsubscribe?: boolean;
    test?: boolean;
  } | null;
  if (!body) throw error(400, 'bad_json');

  if (body.test) {
    const sent = await sendPush({
      title: '✅ Domo — test',
      body: 'Les alertes fonctionnent. Vous serez prévenu en cas d’anomalie.',
      tag: 'domo-test',
      url: '/reglages'
    });
    return json({ ok: true, sent });
  }

  if (body.unsubscribe && typeof body.endpoint === 'string') {
    removeSubscription(body.endpoint);
    return json({ ok: true, unsubscribed: true });
  }
  if (typeof body.endpoint !== 'string' || !body.keys) {
    throw error(400, 'invalid_subscription');
  }
  addSubscription(body as unknown as Parameters<typeof addSubscription>[0]);
  return json({ ok: true });
};
