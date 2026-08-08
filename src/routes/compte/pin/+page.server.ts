/**
 * Page « Mon code » — chargement serveur.
 *
 * Volontairement HORS navigation (ni nav-items, ni menu-items) : on y accède
 * par URL directe le temps de cette phase. La vraie page d'administration des
 * utilisateurs viendra plus tard.
 */
import type { PageServerLoad } from './$types';
import { readUsers } from '$lib/server/users-store';

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;

  // Session legacy : on ne sait pas qui c'est, donc pas de PIN attribuable.
  if (!user || user.id === 'legacy') {
    return { identifie: false as const, email: null, role: null, membres: [] };
  }

  // La liste des membres n'est renvoyée QU'À un administrateur — et réduite à
  // l'identifiant et l'email. Aucun hachage, aucun compteur, aucune date ne
  // franchit la frontière serveur → client.
  const membres =
    user.role === 'admin'
      ? (await readUsers())
          .filter((u) => u.status === 'active' && u.id !== user.id)
          .map((u) => ({ id: u.id, email: u.email }))
      : [];

  return { identifie: true as const, email: user.email, role: user.role, membres };
};
