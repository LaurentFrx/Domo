import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkMagicToken, setSessionCookie } from '$lib/server/auth';
import { findActiveAdmin, touchLastLogin } from '$lib/server/users-store';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = url.searchParams.get('k');

  if (!token || !checkMagicToken(token)) {
    throw error(403, 'Lien invalide');
  }

  // Le lien magique est GLOBAL : il n'identifie personne par lui-même. On le
  // rattache donc au propriétaire (unique administrateur actif), ce qui suffit
  // à faire exister une identité dans la session. Les liens d'invitation
  // nominatifs — un token par personne — viendront dans une phase séparée ;
  // c'est eux qui rendront « supprimer un email » réellement effectif.
  const admin = await findActiveAdmin();
  if (!admin) {
    // Magasin vide, illisible ou sans administrateur actif : on n'enferme
    // personne dehors, on pose le cookie anonyme d'avant. Un AUTH_TOKEN correct
    // doit toujours ouvrir la porte.
    console.error('[auth] aucun administrateur actif dans users.json → cookie legacy émis');
    setSessionCookie(cookies);
    throw redirect(303, '/');
  }

  setSessionCookie(cookies, admin.id);
  await touchLastLogin(admin.id);

  // Redirect vers l'accueil
  throw redirect(303, '/');
};
