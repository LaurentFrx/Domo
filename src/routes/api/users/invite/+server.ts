/**
 * Invitations nominatives.
 *
 *   POST   { userId, ttlDays? }  → émet un lien, renvoie le jeton UNE fois
 *   DELETE { userId }            → révoque le lien en cours
 *
 * Contrôle de rôle : uniquement dans la table de $lib/server/access, appliquée
 * par le hook. Rien n'est revérifié ici.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issueInvite, revokeInvite, findUserById } from '$lib/server/users-store';

/** Session identifiée ET administratrice, sinon la raison du refus. */

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    userId?: unknown;
    ttlDays?: unknown;
  } | null;

  if (typeof body?.userId !== 'string' || !body.userId) {
    return json({ error: 'format', message: 'userId requis.' }, { status: 400 });
  }

  // Durée bornée : ni un lien d'une heure inutilisable en pratique, ni un lien
  // quasi permanent qui reproduirait le problème qu'on vient de corriger.
  let ttlDays = 7;
  if (body.ttlDays !== undefined) {
    if (typeof body.ttlDays !== 'number' || !Number.isFinite(body.ttlDays)) {
      return json({ error: 'format', message: 'ttlDays invalide.' }, { status: 400 });
    }
    if (body.ttlDays < 1 || body.ttlDays > 30) {
      return json({ error: 'format', message: 'ttlDays doit aller de 1 à 30.' }, { status: 400 });
    }
    ttlDays = Math.round(body.ttlDays);
  }

  const cible = await findUserById(body.userId);
  if (!cible)
    return json({ error: 'introuvable', message: 'Utilisateur inconnu.' }, { status: 404 });
  if (cible.status === 'revoked') {
    return json(
      { error: 'revoque', message: 'Ce compte est révoqué — réactive-le d’abord.' },
      { status: 409 }
    );
  }

  const { token, expiresAt } = await issueInvite(body.userId, ttlDays * 24 * 60 * 60 * 1000);

  // On renvoie le CHEMIN, pas une URL absolue : le serveur devinerait mal son
  // origine publique derrière Caddy, alors que le navigateur la connaît.
  return json({
    ok: true,
    email: cible.email,
    path: `/auth?k=${token}`,
    expiresAt,
    ttlDays
  });
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof body?.userId !== 'string' || !body.userId) {
    return json({ error: 'format', message: 'userId requis.' }, { status: 400 });
  }

  await revokeInvite(body.userId);
  return json({ ok: true });
};
