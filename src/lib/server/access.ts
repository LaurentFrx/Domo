/**
 * QUI A LE DROIT DE QUOI — source unique.
 *
 * Avant ce module, la même règle était écrite à trois endroits : une liste de
 * chemins dans le hook, une fonction `exigeAdmin()` recopiée dans deux fichiers
 * de routes, et un filtre dans le menu. Trois définitions qui pouvaient
 * diverger, donc trois occasions de croire une porte fermée alors qu'elle ne
 * l'était pas. Il n'y en a plus qu'une : cette table.
 *
 * Ce n'est PAS une liste de chemins « admin » : c'est la liste des OPÉRATIONS
 * réservées, méthode comprise. Lire la configuration du cumulus reste ouvert à
 * tout le monde ; seule son écriture est réservée. Confondre les deux
 * fermerait des pages entières sans raison.
 *
 * Le libellé n'est pas décoratif : il part dans le refus, pour que l'app puisse
 * dire « Réglage de la boucle SB3 réservé » plutôt qu'un « interdit » muet.
 */

export interface Reserve {
  /** Méthodes concernées, ou `'*'` pour toutes (cas des pages). */
  methodes: readonly string[] | '*';
  /** Chemin exact, ou racine d'une branche si `prefixe` est vrai (sans / final). */
  chemin: string;
  prefixe?: boolean;
  /** Ce qui est réservé, en français, à destination de l'utilisateur. */
  libelle: string;
}

export const RESERVE_ADMIN: readonly Reserve[] = [
  // ── Énergie : les réglages qui engagent l'installation ────────────────
  {
    methodes: ['PUT', 'POST', 'PATCH', 'DELETE'],
    chemin: '/api/cumulus/config',
    libelle: 'La configuration du cumulus'
  },
  {
    methodes: ['POST'],
    chemin: '/api/sb3loop/command',
    libelle: 'Le réglage de la boucle SB3'
  },
  {
    methodes: ['POST'],
    chemin: '/api/apsloop/command',
    libelle: 'Le bridage de l’onduleur'
  },

  // ── Musique : effacer un fichier est irréversible ─────────────────────
  {
    methodes: ['DELETE'],
    chemin: '/api/plex/item',
    prefixe: true,
    libelle: 'La suppression d’un morceau'
  },

  // ── Accès : la gestion des comptes du foyer ───────────────────────────
  // La PAGE /menu/acces n'est pas réservée : elle s'adapte (le foyer pour un
  // administrateur, sa seule fiche pour les autres). Seules les opérations le
  // sont. C'est ce qui permet au menu de ne plus rien savoir des rôles.
  { methodes: '*', chemin: '/api/users', prefixe: true, libelle: 'La gestion des accès' }
];

/** La règle qui couvre cette requête, ou `null` si l'opération est ouverte. */
export function reservePour(methode: string, chemin: string): Reserve | null {
  for (const r of RESERVE_ADMIN) {
    const okMethode = r.methodes === '*' || r.methodes.includes(methode);
    if (!okMethode) continue;
    // Comparaison par SEGMENT, jamais par préfixe de chaîne : sans ça
    // `/api/usersautre` serait attrapé par la règle de `/api/users`. Le repo
    // connaît déjà ce piège (cf. isActive dans nav-items.ts).
    const okChemin = r.prefixe
      ? chemin === r.chemin || chemin.startsWith(r.chemin + '/')
      : chemin === r.chemin;
    if (okChemin) return r;
  }
  return null;
}
