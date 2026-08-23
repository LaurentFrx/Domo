/**
 * Sonde d'authentification pour Caddy (`forward_auth`) — garde les services
 * voisins du même domaine derrière le cookie Domo (ex. /apercu, le rendu brut
 * des fichiers partagés). Répond 204 pour TOUT membre actif de la maison :
 * les hooks ont déjà refusé les autres (cookie absent/invalide ⇒ 303 /denied,
 * compte révoqué ⇒ pareil — non-2xx = refus côté Caddy).
 *
 * Le Filebrowser, lui, est gardé par la sonde voisine `check-admin` :
 * consulter un fichier est familial, GÉRER les fichiers est réservé à Laurent.
 */
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => new Response(null, { status: 204 });
