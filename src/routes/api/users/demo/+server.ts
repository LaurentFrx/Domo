/**
 * POST /api/users/demo — crée un accès de démonstration et son lien, d'un geste.
 *
 * Corps : { donnees: 'reelles' | 'fictives', ttlDays? }
 *
 * Un compte jetable plutôt qu'un mécanisme à part : il apparaît dans la page
 * Accès comme les autres, se révoque comme les autres, expire comme les autres.
 * Rien de neuf à comprendre ni à maintenir.
 *
 * Le contrôle de rôle vit dans $lib/server/access (le chemin est sous
 * /api/users, donc déjà réservé) — on ne le refait pas ici.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createUser, issueInvite, type DemoDonnees } from '$lib/server/users-store';

/** Durée courte par défaut : une démo se fait dans la journée, pas sur la semaine. */
const TTL_JOURS_DEFAUT = 2;

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    donnees?: unknown;
    ttlDays?: unknown;
  } | null;

  const donnees = body?.donnees;
  if (donnees !== 'reelles' && donnees !== 'fictives') {
    return json(
      { error: 'format', message: 'Choisis « données réelles » ou « maison simulée ».' },
      { status: 400 }
    );
  }

  let ttlDays = TTL_JOURS_DEFAUT;
  if (body?.ttlDays !== undefined) {
    if (
      typeof body.ttlDays !== 'number' ||
      !Number.isFinite(body.ttlDays) ||
      body.ttlDays < 1 ||
      body.ttlDays > 30
    ) {
      return json({ error: 'format', message: 'Durée invalide (1 à 30 jours).' }, { status: 400 });
    }
    ttlDays = Math.round(body.ttlDays);
  }

  // Adresse jetable et lisible : elle sert d'étiquette dans la liste, pas à
  // écrire à qui que ce soit. Le suffixe horodaté évite les collisions quand on
  // enchaîne deux démos le même jour.
  const etiquette = donnees === 'fictives' ? 'simulee' : 'reelle';
  const email = `demo-${etiquette}-${Date.now().toString(36)}@demo.local`;

  const compte = await createUser({
    email,
    role: 'demo',
    status: 'active',
    demoDonnees: donnees as DemoDonnees
  });
  const { token, expiresAt } = await issueInvite(compte.id, ttlDays * 24 * 60 * 60 * 1000);

  return json({
    ok: true,
    id: compte.id,
    email,
    donnees,
    path: `/auth?k=${token}`,
    expiresAt,
    ttlDays
  });
};
