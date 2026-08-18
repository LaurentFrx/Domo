/**
 * Administration des comptes.
 *
 *   GET                                   → liste
 *   POST   { email, role }                → crée un compte
 *   PATCH  { userId, role?, status? }     → change droits / accès
 *   DELETE { userId }                     → supprime
 *
 * Le contrôle de rôle N'EST PAS refait ici : il vit à un seul endroit, la table
 * de $lib/server/access appliquée par le hook. Le redoubler, c'était la même
 * règle écrite deux fois, donc deux occasions de diverger.
 *
 * Ce qui sort d'ici est DÉLIBÉRÉMENT réduit : ni empreinte de PIN, ni sel, ni
 * empreinte d'invitation. Le client n'a besoin que de savoir si un code et un
 * lien existent, pas de quoi ils sont faits.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createUser,
  deleteUser,
  readUsers,
  updateUser,
  DernierAdminError,
  type UserRole,
  type UserStatus
} from '$lib/server/users-store';

const ROLES: readonly UserRole[] = ['admin', 'famille'];
const STATUSES: readonly UserStatus[] = ['active', 'revoked'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Vue publique d'un compte : des faits, jamais de secrets. */
async function liste() {
  const now = Date.now();
  return (await readUsers()).map((u) => ({
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
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt
  }));
}

export const GET: RequestHandler = async () => {
  return json({ users: await liste() });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    role?: unknown;
  } | null;

  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!EMAIL_RE.test(email)) {
    return json({ error: 'format', message: 'Adresse e-mail invalide.' }, { status: 400 });
  }
  const role = ROLES.includes(body?.role as UserRole) ? (body?.role as UserRole) : 'famille';

  try {
    const cree = await createUser({ email, role, status: 'active' });
    return json({ ok: true, user: { id: cree.id, email: cree.email, role: cree.role } });
  } catch {
    return json({ error: 'doublon', message: 'Cette adresse existe déjà.' }, { status: 409 });
  }
};

export const PATCH: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    userId?: unknown;
    role?: unknown;
    status?: unknown;
  } | null;

  if (typeof body?.userId !== 'string' || !body.userId) {
    return json({ error: 'format', message: 'userId requis.' }, { status: 400 });
  }
  if (body.role !== undefined && !ROLES.includes(body.role as UserRole)) {
    return json({ error: 'format', message: 'Rôle inconnu.' }, { status: 400 });
  }
  if (body.status !== undefined && !STATUSES.includes(body.status as UserStatus)) {
    return json({ error: 'format', message: 'Statut inconnu.' }, { status: 400 });
  }

  try {
    const u = await updateUser(body.userId, {
      role: body.role as UserRole | undefined,
      status: body.status as UserStatus | undefined
    });
    return json({ ok: true, user: { id: u.id, email: u.email, role: u.role, status: u.status } });
  } catch (e) {
    if (e instanceof DernierAdminError) {
      return json(
        {
          error: 'dernier_admin',
          message: 'Impossible : il doit rester au moins un administrateur actif.'
        },
        { status: 409 }
      );
    }
    return json({ error: 'introuvable', message: 'Utilisateur inconnu.' }, { status: 404 });
  }
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof body?.userId !== 'string' || !body.userId) {
    return json({ error: 'format', message: 'userId requis.' }, { status: 400 });
  }

  try {
    await deleteUser(body.userId);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof DernierAdminError) {
      return json(
        {
          error: 'dernier_admin',
          message: 'Impossible : il doit rester au moins un administrateur actif.'
        },
        { status: 409 }
      );
    }
    throw e;
  }
};
