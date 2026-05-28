import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkMagicToken, setSessionCookie } from '$lib/server/auth';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = url.searchParams.get('k');

  if (!token || !checkMagicToken(token)) {
    throw error(403, 'Lien invalide');
  }

  // Token OK → poser le cookie 1 an
  setSessionCookie(cookies);

  // Redirect vers l'accueil
  throw redirect(303, '/');
};
