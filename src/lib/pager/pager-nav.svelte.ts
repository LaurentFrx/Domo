/**
 * Source de vérité de la navigation VISIBLE quand le pager pilote l'affichage.
 *
 * Pourquoi : le pager change de page par `pushState` (zéro re-montage), mais
 * `pushState` (shallow routing) ne met PAS `page.url` à jour — il ne change que la
 * barre d'URL et `page.state`. Donc la TabBar / Sidebar / le <title>, s'ils se
 * basaient sur `page.url`, resteraient sur la page d'origine après un swipe.
 *
 * Le pager écrit ici l'href de sa page centrale ; la TabBar et le titre s'y réfèrent
 * via `activeNavHref`. `current` est null quand le pager n'est pas monté (SSR,
 * sous-route type /reglages/planning) → repli automatique sur le routeur.
 */
import { navItems, isActive } from '$components/layout/nav-items';

export const pagerNav = $state<{ current: string | null }>({ current: null });

/** Href de nav actif effectif : le pager s'il pilote, sinon le routeur (`pathname`). */
export function activeNavHref(pathname: string): string {
  return pagerNav.current ?? navItems.find((n) => isActive(pathname, n.href))?.href ?? '/';
}
