/**
 * Page « Utilisateurs » — chargement serveur.
 *
 * La garde de rôle du hook (`ADMIN_ONLY`) a déjà refusé les non-administrateurs
 * avant d'arriver ici ; ce `load` n'a donc pas à re-vérifier pour protéger, mais
 * il renvoie `moiId` pour que l'interface sache quelle ligne est celle de la
 * personne connectée — on ne propose pas à quelqu'un de se révoquer lui-même.
 */
import type { PageServerLoad } from './$types';
import { readUsers } from '$lib/server/users-store';

export const load: PageServerLoad = async ({ locals }) => {
  const now = Date.now();
  const users = (await readUsers()).map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    aUnCode: u.pinHash !== null,
    invitation:
      u.inviteHash === null
        ? null
        : {
            expiresAt: u.inviteExpiresAt,
            perimee: u.inviteExpiresAt !== null && u.inviteExpiresAt <= now,
            utiliseeLe: u.inviteUsedAt
          },
    lastLoginAt: u.lastLoginAt
  }));

  return { users, moiId: locals.user?.id ?? null };
};
