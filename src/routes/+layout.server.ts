/**
 * Identité de la session, disponible dans toute l'app via `page.data.user`.
 *
 * Sert d'abord à ne PAS montrer à Isabelle une rubrique qu'elle ne peut pas
 * ouvrir : la garde de rôle du hook la protégerait de toute façon, mais une
 * cellule qui mène à un 403 est une fausse promesse, pas une sécurité.
 *
 * Ce `load` ne lit NI l'URL, NI les paramètres, NI `fetch` : SvelteKit n'a donc
 * aucune dépendance à suivre et ne le rejoue pas à chaque navigation. C'est
 * important ici — le pager enchaîne les navigations au doigt, un aller-retour
 * réseau par balayage se verrait.
 */
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return { user: locals.user ?? null };
};
