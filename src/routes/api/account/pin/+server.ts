/**
 * POST /api/account/pin — définir un PIN de secours.
 *
 * Route PROTÉGÉE par l'authentification normale : on ne pose un PIN que depuis
 * une session déjà ouverte. C'est volontaire — sinon le PIN deviendrait une
 * porte d'entrée qu'on peut se créer soi-même sans jamais avoir eu le lien
 * magique.
 *
 * Deux usages :
 *   • self-service  { pin }            → son propre PIN
 *   • pour autrui   { pin, userId }    → réservé à role='admin'
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setUserPin } from '$lib/server/users-store';
import { isValidPinFormat } from '$lib/server/pin';

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = locals.user;

  // Une session legacy (cookie anonyme d'avant la phase identité) ne dit pas
  // QUI est derrière : impossible de lui attribuer un PIN.
  if (!user || user.id === 'legacy') {
    return json(
      {
        error: 'session_non_identifiee',
        message: 'Ouvre d’abord l’app avec ton lien magique, puis reviens définir ton code.'
      },
      { status: 401 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    pin?: unknown;
    userId?: unknown;
  } | null;

  const targetId =
    typeof body?.userId === 'string' && body.userId ? body.userId : (user.id as string);

  if (targetId !== user.id && user.role !== 'admin') {
    return json(
      { error: 'interdit', message: 'Seul un administrateur peut définir le code d’un autre.' },
      { status: 403 }
    );
  }

  if (!isValidPinFormat(body?.pin)) {
    return json(
      { error: 'format', message: 'Le code doit faire exactement 4 chiffres.' },
      { status: 400 }
    );
  }

  try {
    await setUserPin(targetId, body.pin as string);
  } catch {
    return json({ error: 'introuvable', message: 'Utilisateur inconnu.' }, { status: 404 });
  }

  // Réponse minimale : jamais d'écho du code, ni du hachage.
  return json({ ok: true });
};
