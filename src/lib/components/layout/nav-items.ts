// Source UNIQUE de la navigation principale, partagée par TabBar (mobile, en bas)
// et Sidebar (desktop, à gauche). Évite la dérive — auparavant les deux
// composants dupliquaient hrefs / labels / chemins d'icônes : une route ajoutée
// à un seul des deux passait inaperçue. Le markup et les styles restent propres
// à chaque composant (TabBar opaque, Sidebar indigo) ; seules la DONNÉE et la
// logique de correspondance sont mutualisées ici.

export interface NavItem {
  href: string;
  label: string;
  /** Chemin SVG (attribut `d`), tracé sur un viewBox 0 0 24 24. */
  icon: string;
}

export const navItems: NavItem[] = [
  { href: '/', label: 'Accueil', icon: 'M3 11 L12 3 L21 11 V20 H3 Z' },
  { href: '/energie', label: 'Énergie', icon: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z' },
  {
    href: '/climat',
    label: 'Climat',
    icon: 'M12 2 C12 2 8 6 8 12 C8 16 10 19 12 19 C14 19 16 16 16 12 C16 8 14 6 14 6 C14 8 13 10 12 10 C11 10 12 6 12 2 Z'
  },
  {
    href: '/pieces',
    label: 'Pièces',
    icon: 'M3 3 H10 V10 H3 Z M14 3 H21 V10 H14 Z M3 14 H10 V21 H3 Z M14 14 H21 V21 H14 Z'
  },
  {
    href: '/maison',
    label: 'Maison',
    icon: 'M12 2 L21 7 V17 L12 22 L3 17 V7 Z M3 7 L12 12 L21 7 M12 12 V22'
  },
  {
    href: '/reglages',
    label: 'Réglages',
    icon: 'M12 8 A4 4 0 1 1 12 16 A4 4 0 1 1 12 8 Z M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.5 4.5 L6.5 6.5 M17.5 17.5 L19.5 19.5 M4.5 19.5 L6.5 17.5 M17.5 6.5 L19.5 4.5'
  }
];

// Suivi du lien actif par SEGMENT (et non par simple préfixe de chaîne) :
// `/maison` ne s'allume pas pour un hypothétique `/maisonnette`, mais `/reglages`
// reste actif sur `/reglages/planning`. Fonction pure (path passé en argument)
// pour rester testable et découplée du store de page.
export function isActive(path: string, href: string): boolean {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}
