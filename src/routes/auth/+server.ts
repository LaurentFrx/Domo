import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkMagicToken, setSessionCookie } from '$lib/server/auth';
import {
  findActiveAdmin,
  findUserByInviteToken,
  markInviteUsed,
  touchLastLogin
} from '$lib/server/users-store';

/**
 * GET /auth?k=<jeton> — entrée dans l'app.
 *
 * DEUX natures de jeton, dans cet ordre :
 *
 *   1. INVITATION NOMINATIVE (phase 3) — un jeton par personne, borné dans le
 *      temps, révocable. C'est la voie normale : c'est elle qui fait qu'une
 *      session sait QUI est entré, donc que retirer quelqu'un le coupe vraiment.
 *
 *   2. AUTH_TOKEN global — conservé, mais rétrogradé en TRAPPE DE SECOURS de
 *      l'administrateur. Il ne se partage plus : il vit dans `.env` sur le VPS
 *      et reste la seule façon de rentrer si le magasin est vide, illisible, ou
 *      si toutes les invitations ont expiré. Le supprimer ferait de Domo une
 *      porte sans serrure de secours ; le partager annulerait la phase 3.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = url.searchParams.get('k');
  if (!token) throw error(403, 'Lien invalide');

  // ── 1. Invitation nominative ──────────────────────────────────────────
  const invite = await findUserByInviteToken(token);
  if (invite) {
    setSessionCookie(cookies, invite.id);
    await markInviteUsed(invite.id);
    await touchLastLogin(invite.id);
    throw redirect(303, '/');
  }

  // ── 2. Trappe de secours ──────────────────────────────────────────────
  if (!checkMagicToken(token)) {
    throw error(403, 'Lien invalide');
  }

  const admin = await findActiveAdmin();
  if (!admin) {
    // Magasin vide, illisible ou sans administrateur actif : on n'enferme
    // personne dehors, on pose le cookie anonyme d'avant. Un AUTH_TOKEN correct
    // doit toujours ouvrir la porte.
    console.error('[auth] aucun administrateur actif dans users.json → cookie legacy émis');
    setSessionCookie(cookies);
    throw redirect(303, '/');
  }

  console.warn(`[auth] entrée par la trappe de secours AUTH_TOKEN (admin ${admin.email})`);
  setSessionCookie(cookies, admin.id);
  await touchLastLogin(admin.id);

  throw redirect(303, '/');
};
