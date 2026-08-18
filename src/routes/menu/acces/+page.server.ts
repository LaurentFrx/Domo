/**
 * « Accès » — page unique des comptes du foyer.
 *
 * Elle remplace DEUX pages qui se marchaient dessus : « Utilisateurs » listait
 * les gens sans pouvoir poser leur code, « Mon code » posait les codes sans
 * montrer les gens. Il fallait deviner laquelle ouvrir.
 *
 * Elle n'est pas réservée : elle S'ADAPTE. Un administrateur y voit le foyer,
 * quelqu'un d'autre n'y voit que sa propre fiche. C'est ce qui permet au menu de
 * ne plus rien savoir des rôles — une cellule unique, visible par tous.
 */
import type { PageServerLoad } from './$types';
import { readUsers } from '$lib/server/users-store';

export const load: PageServerLoad = async ({ locals }) => {
  const moi = locals.user ?? null;
  const estAdmin = moi?.role === 'admin';
  // Un visiteur de démonstration n'a pas de compte à administrer : la page le
  // lui dit en une phrase plutôt que de lui montrer une fiche inutilisable.
  const estDemo = moi?.role === 'demo';
  const identifie = !!moi && moi.id !== 'legacy';
  const now = Date.now();

  // Une session legacy ne dit pas qui est derrière : aucune fiche à montrer.
  const tous = identifie ? await readUsers() : [];
  const visibles = estAdmin ? tous : tous.filter((u) => u.id === moi?.id);

  return {
    identifie,
    estAdmin,
    estDemo,
    moiId: moi?.id ?? null,
    // Des faits, jamais de secrets : ni empreinte de code, ni empreinte de lien.
    gens: visibles.map((u) => ({
      id: u.id,
      email: u.email,
      peutToutRegler: u.role === 'admin',
      demo: u.role === 'demo' ? (u.demoDonnees ?? 'reelles') : null,
      accesRetire: u.status === 'revoked',
      aUnCode: u.pinHash !== null,
      lien:
        u.inviteHash === null
          ? null
          : {
              expireLe: u.inviteExpiresAt,
              perime: u.inviteExpiresAt !== null && u.inviteExpiresAt <= now
            },
      // « Jamais venu » est déduit d'ici — ce n'est plus un état stocké.
      derniereVenue: u.lastLoginAt
    }))
  };
};
