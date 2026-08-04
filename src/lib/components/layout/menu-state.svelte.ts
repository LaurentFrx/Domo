/**
 * État d'ouverture de la feuille « ☰ ». Module-level (une seule instance pour
 * toute l'app) : la TabBar (iPhone) et la Sidebar (iPad/desktop) l'ouvrent, la
 * feuille montée une seule fois dans +layout.svelte la rend. Sans ça, chaque
 * barre porterait sa propre copie de la feuille → deux panneaux possibles.
 */
export const menuSheet = $state<{ open: boolean }>({ open: false });

export function openMenu() {
  menuSheet.open = true;
}
export function closeMenu() {
  menuSheet.open = false;
}
