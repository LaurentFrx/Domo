// Registre UNIQUE du menu « ☰ » — le tiroir où vit tout ce qui n'est pas le geste
// quotidien : pages de suivi qu'on ouvre à l'occasion, réglages, informations
// techniques, automatismes de fond. La navigation principale (nav-items.ts) ne
// garde que les quatre pages qu'on ouvre plusieurs fois par jour.
//
// Structure calquée sur l'app Réglages d'iOS : des GROUPES de cellules, séparés
// par des en-têtes gris, avec parfois une note explicative sous le groupe. Une
// cellule = une destination ; l'icône est un carré arrondi coloré (SF-like).
//
// Deux natures de destination :
//   • les rubriques /menu/… — rendues dans la surface « Réglages iOS »
//     (cf. src/lib/styles/ios-settings.css) ;
//   • les pages EXTERNES (`external: true`, ex. /energie, /maison) — elles
//     gardent le langage visuel de l'app : ce sont des écrans de données riches
//     (graphes, Sankey, 3D), les habiller en liste de réglages n'aurait aucun
//     sens. Elles portent en tête un retour « ‹ Menu ».

export interface MenuItem {
  href: string;
  label: string;
  /** Sous-titre optionnel — iOS l'emploie avec parcimonie. */
  description?: string;
  /** Chemin SVG (attribut `d`), tracé sur un viewBox 0 0 24 24. */
  icon: string;
  /** Couleur du carré d'icône (jeton --ios-* du kit). */
  tint: string;
  /** Termes supplémentaires pour la recherche (le libellé est déjà indexé). */
  keywords?: string;
  /** Page hors espace /menu : garde le design de l'app. */
  external?: boolean;
}

export interface MenuGroup {
  header?: string;
  footer?: string;
  items: MenuItem[];
}

export const menuGroups: MenuGroup[] = [
  {
    items: [
      {
        href: '/energie',
        label: 'Énergie',
        icon: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z',
        tint: 'var(--ios-orange)',
        keywords: 'production solaire panneaux courbe prévision électroménager mensuel eau chaude',
        external: true
      },
      {
        href: '/maison',
        label: 'Maison en 3D',
        icon: 'M12 2 L21 7 V17 L12 22 L3 17 V7 Z M3 7 L12 12 L21 7 M12 12 V22',
        tint: 'var(--ios-indigo)',
        keywords: 'plan pièces maquette dollhouse volumes',
        external: true
      }
    ]
  },
  {
    header: 'Énergie & confort',
    items: [
      {
        href: '/menu/energie',
        label: 'Automatismes',
        icon: 'M21 12a9 9 0 1 1-2.6-6.4 M21 3v6h-6 M12 8v4l2.5 2.5',
        tint: 'var(--ios-blue)',
        keywords: 'boucle sb3 solarbank batterie bridage onduleur aps injection modbus consigne'
      },
      {
        href: '/menu/eau-chaude',
        label: 'Eau chaude',
        icon: 'M12 3s6 5.5 6 10a6 6 0 0 1-12 0c0-4.5 6-10 6-10Z',
        tint: 'var(--ios-teal)',
        keywords: 'cumulus ballon chauffe-eau shelly labo shadow'
      },
      {
        href: '/menu/chauffage',
        label: 'Chauffage salle de bain',
        icon: 'M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z',
        tint: 'var(--ios-red)',
        keywords: 'sèche-serviette thermostat tpi presets planning isabelle matins'
      }
    ]
  },
  {
    header: 'Installation',
    items: [
      {
        href: '/menu/bilan',
        label: 'Bilan & installation',
        icon: 'M3 3v18h18 M7 15l4-5 3 3 5-7',
        tint: 'var(--ios-green)',
        keywords: 'production totale équivalent tarifs edf hp hc prix matériel coût phases'
      },
      {
        href: '/menu/appareils',
        label: 'Appareils & capteurs',
        icon: 'M5 12.55a11 11 0 0 1 14 0 M8.5 16.05a6 6 0 0 1 7 0 M2 9a15 15 0 0 1 20 0 M12 20h.01',
        tint: 'var(--ios-purple)',
        keywords: 'liaisons connexions zigbee matter airzone daikin piles batteries capteurs'
      }
    ]
  },
  {
    header: 'Général',
    items: [
      {
        href: '/menu/acces',
        label: 'Accès',
        description: 'Qui entre dans Domo, et avec quel code',
        icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
        tint: 'var(--ios-blue)',
        keywords: 'utilisateurs comptes famille invitation lien code pin 4 chiffres droits isabelle'
      },
      {
        href: '/menu/apparence',
        label: 'Apparence',
        icon: 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z',
        tint: 'var(--ios-gray)',
        keywords: 'thème clair sombre animations affichage'
      },
      {
        href: '/menu/systeme',
        label: 'Système',
        icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 7.3 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 15a1.65 1.65 0 0 0-1.51-1H1a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 7.3 4.6H8a2 2 0 1 1 4 0',
        tint: 'var(--ios-gray)',
        keywords: 'alertes anomalies notifications push version hôte domaine'
      }
    ]
  }
];

/** Toutes les cellules, à plat — recherche, titres, correspondance de route. */
export const menuItems: MenuItem[] = menuGroups.flatMap((g) => g.items);

/** Icône « trois traits » du bouton d'ouverture (viewBox 0 0 24 24). */
export const MENU_ICON = 'M4 7h16 M4 12h16 M4 17h16';

/** Vrai si le chemin appartient à l'espace du menu (index ou rubrique). */
export function isMenuPath(path: string): boolean {
  return path === '/menu' || path.startsWith('/menu/');
}

/**
 * Vrai si l'on se trouve DANS une destination du menu — l'espace /menu, mais
 * aussi les pages externes qu'il ouvre (/energie, /maison). Sert à allumer le
 * bouton « ☰ » : sur /energie, aucun onglet de pilotage ne doit briller, et
 * laisser la barre entièrement éteinte perdrait l'utilisateur.
 */
export function isMenuDestination(path: string): boolean {
  if (isMenuPath(path)) return true;
  return menuItems.some((m) => m.external && (path === m.href || path.startsWith(m.href + '/')));
}

/**
 * Libellé de la rubrique correspondant à un chemin — sert à l'en-tête des
 * sous-pages du menu. Correspondance par SEGMENT (pas par préfixe de chaîne)
 * pour qu'une éventuelle sous-sous-route reste rattachée à sa rubrique.
 * Les pages externes sont ignorées : elles portent leur propre en-tête.
 */
export function menuLabelFor(path: string): string | null {
  if (path === '/menu') return 'Menu';
  const hit = menuItems.find(
    (m) => !m.external && (path === m.href || path.startsWith(m.href + '/'))
  );
  return hit?.label ?? null;
}

// Pages ATTEIGNABLES sans être dans la navigation ni dans une cellule du menu :
// ouvertes depuis une rubrique, elles gardent le langage visuel de l'app.
// Sans cette table, leur onglet s'intitulerait « Domo ». /planning n'y figure
// pas : il porte son propre <svelte:head><title> (« Mes matins »), et deux
// sources de titre finiraient par diverger.
const OFF_NAV_TITLES: Record<string, string> = {
  '/cumulus-labo': 'Labo eau chaude'
};

/** Titre d'onglet pour une page hors navigation principale, ou null. */
export function pageTitleFor(path: string): string | null {
  const external = menuItems.find((m) => m.external && m.href === path);
  return menuLabelFor(path) ?? external?.label ?? OFF_NAV_TITLES[path] ?? null;
}

/**
 * Filtre de la barre de recherche (accents et casse ignorés) : un champ inerte
 * serait un faux affordance — celui-ci filtre réellement les cellules, sur le
 * libellé ET sur des mots-clés métier (« tarif » trouve « Bilan », « volet »
 * ne trouve rien plutôt que de mentir).
 */
export function filterGroups(query: string): MenuGroup[] {
  const q = normalize(query.trim());
  if (!q) return menuGroups;
  const terms = q.split(/\s+/);
  return menuGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        const hay = normalize(`${it.label} ${it.description ?? ''} ${it.keywords ?? ''}`);
        return terms.every((t) => hay.includes(t));
      })
    }))
    .filter((g) => g.items.length > 0);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
