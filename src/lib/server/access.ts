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

  // ── Musique : le mode Gérer (le disque de la bibliothèque) ────────────
  {
    methodes: ['DELETE'],
    chemin: '/api/plex/item',
    prefixe: true,
    libelle: 'La suppression d’un morceau'
  },
  {
    methodes: ['POST'],
    chemin: '/api/plex/upload',
    libelle: 'L’ajout de musique'
  },
  {
    methodes: ['POST'],
    chemin: '/api/plex/scan',
    libelle: 'L’analyse de la bibliothèque'
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

// ─── Endpoints qui portent leur PROPRE authentification ────────────────

/**
 * Chemins appelés sans cookie Domo : le raccourci iPhone du portail et les
 * ticks des timers systemd. Ils s'authentifient eux-mêmes par `Authorization:
 * Bearer`, et sortent donc de la garde des droits.
 *
 * LA CONDITION SUR L'EN-TÊTE N'EST PAS DÉCORATIVE. Sans elle, la dérogation
 * s'appliquait à TOUT appel sur ces chemins, cookie compris — or /api/portail/pulse
 * accepte aussi « cookie + en-tête x-domo-app », exactement ce qu'envoie le
 * bouton de /pieces. Un visiteur de démonstration ouvrait donc le portail en
 * cliquant dessus. Trouvé par le test de bout en bout du 2026-08-18.
 */
const AUTH_PAR_JETON = [
  '/api/portail/pulse',
  '/api/cumulus/tick',
  '/api/monitor/tick',
  '/api/sb3loop/tick',
  '/api/apsloop/tick',
  '/api/temperature/tick'
];

/** Vrai si la requête doit court-circuiter la garde (appel à jeton, match EXACT). */
export function authParJeton(chemin: string, aEnteteAuthorization: boolean): boolean {
  return aEnteteAuthorization && AUTH_PAR_JETON.includes(chemin);
}

// ─── Démonstration : lecture seule, une règle et pas une liste ─────────

/** Seule écriture tolérée en démonstration : partir. */
const ECRITURES_TOLEREES_DEMO = ['/api/auth/logout'];

/**
 * Chemins interdits en démonstration MÊME EN LECTURE, quelle que soit la source
 * des données. Find My diffuse le nom et la position GPS des appareils de la
 * famille : ça n'a rien à faire dans une démo, y compris « sur données réelles ».
 */
const JAMAIS_EN_DEMO = ['/api/findmy'];

export interface Refus {
  message: string;
}

/**
 * LE point de décision : cette requête est-elle refusée, et pourquoi ?
 *
 * Regroupe ici les deux règles qui existent — opérations réservées à
 * l'administrateur, et lecture seule de la démonstration — pour qu'il n'y ait
 * jamais deux endroits à consulter avant de savoir qui a le droit de quoi.
 */
export function refusPour(role: string, methode: string, chemin: string): Refus | null {
  const mutant = methode !== 'GET' && methode !== 'HEAD' && methode !== 'OPTIONS';

  if (role === 'demo') {
    if (JAMAIS_EN_DEMO.some((p) => chemin === p || chemin.startsWith(p + '/'))) {
      return { message: 'Cette donnée n’est pas accessible en démonstration.' };
    }
    if (mutant && !ECRITURES_TOLEREES_DEMO.includes(chemin)) {
      return { message: 'Démonstration en lecture seule : aucune commande n’est possible.' };
    }
  }

  const reserve = reservePour(methode, chemin);
  if (reserve && role !== 'admin') {
    const l = reserve.libelle;
    return { message: `Réservé à l'administrateur : ${l.charAt(0).toLowerCase()}${l.slice(1)}.` };
  }
  return null;
}
