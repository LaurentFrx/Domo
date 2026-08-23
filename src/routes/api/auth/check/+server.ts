/**
 * Sonde d'authentification pour Caddy (`forward_auth`) — protège /files.
 *
 * Le Filebrowser (loopback 8081) tourne SANS mot de passe : c'est cette route
 * qui porte toute la garde. Caddy rejoue chaque requête /files ici avec les
 * cookies du visiteur ; les hooks font le travail — cookie de session absent ou
 * invalide ⇒ 303 /denied (non-2xx = refus côté Caddy), compte révoqué ⇒ pareil.
 * Si on arrive jusqu'ici, c'est qu'un membre actif de la maison est derrière.
 */
import type { RequestHandler } from './$types';

// Réservé à l'ADMINISTRATEUR (demande de Laurent, 23/08) : les fichiers sont les
// siens, pas ceux de la maison. Un membre famille authentifié reçoit 403 —
// non-2xx, donc refus côté Caddy — sans être renvoyé vers /denied (son cookie
// est valide, c'est la ressource qui est privée).
export const GET: RequestHandler = ({ locals }) =>
  new Response(null, { status: locals.user?.role === 'admin' ? 204 : 403 });
