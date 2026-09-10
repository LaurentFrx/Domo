import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Le tableau de bord a d'abord vécu ici, le temps d'une mise en ligne : c'est
 * l'ACCUEIL sur un écran de bureau, pas une destination à part. L'adresse est
 * conservée en redirection permanente — un signet ou un onglet resté ouvert
 * doit atterrir au bon endroit, pas sur un 404.
 */
export const load: PageServerLoad = () => {
  redirect(308, '/');
};
