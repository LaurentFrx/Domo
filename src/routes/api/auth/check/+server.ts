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

export const GET: RequestHandler = () => new Response(null, { status: 204 });
