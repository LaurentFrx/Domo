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
    href: '/musique',
    label: 'Musique',
    icon: 'M9 18 V5 L21 3 V16 M9 18 A3 3 0 1 1 3 18 A3 3 0 1 1 9 18 M21 16 A3 3 0 1 1 15 16 A3 3 0 1 1 21 16'
  }
];

// Ce qui n'est PAS ici vit derrière le bouton « ☰ » (cf. `menu-items.ts`) :
// réglages, informations techniques, automatismes de fond — mais aussi Énergie et
// Maison, qu'on ouvre à l'occasion et non dix fois par jour. La barre ne porte donc
// que le geste quotidien, ce qui la laisse respirer sur iPhone (4 onglets + menu).
// Conséquence à connaître : le pager (swipe 2 doigts) ne balaie QUE ces pages —
// c'est ce qui a permis de retirer le cas particulier WebGL de /maison.

// Suivi du lien actif par SEGMENT (et non par simple préfixe de chaîne) :
// `/maison` ne s'allume pas pour un hypothétique `/maisonnette`, mais un href
// resterait actif sur ses sous-routes. Fonction pure (path passé en argument)
// pour rester testable et découplée du store de page.
export function isActive(path: string, href: string): boolean {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}
