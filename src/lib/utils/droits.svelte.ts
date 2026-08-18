/**
 * « Cette personne peut-elle tout régler ? », côté client.
 *
 * Sert UNIQUEMENT à l'affichage : griser un interrupteur plutôt que le laisser
 * échouer au clic. La décision qui compte est prise côté serveur, par la table
 * de `$lib/server/access`. Ce n'est donc pas la même règle écrite deux fois :
 * le serveur dit qui a le droit, ceci dit ce qu'on montre.
 */
import { page } from '$app/state';

export function peutToutRegler(): boolean {
  return (page.data.user as { role?: string } | null | undefined)?.role === 'admin';
}

/** Phrase affichée à côté d'une commande verrouillée. */
export const RESERVE = 'Réservé à l’administrateur';
