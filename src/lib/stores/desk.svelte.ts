/**
 * « La fenêtre a-t-elle la place du TABLEAU DE BORD ? » — souris ET au moins
 * 1 400 px de large.
 *
 * Pourquoi 1 400 et non 1 280 (le seuil `desk:` de la barre latérale) : mesuré,
 * c'est la largeur à partir de laquelle le tableau de bord tient sur DEUX
 * colonnes. La colonne « Pièces » ne descend pas sous 527 px (sept volets à
 * 73 px plus les marges), soit 1 400 px une fois la barre (240) et les marges
 * (64) déduites. En dessous, il se repliait sur une colonne unique : une pile
 * de 5 000 px, moins lisible que l'écran d'énergie qu'il remplaçait.
 *
 * Ce store existe parce qu'une media query CSS ne peut pas décider ce qu'on
 * MONTE : l'accueil rend le tableau de bord ici et l'écran d'énergie ailleurs —
 * les monter tous les deux pour en masquer un ferait tourner le polling de
 * Climat, Pièces et Musique sur un iPhone. Il commande aussi le pager (pas de
 * balayage à la souris, et le rail monterait une seconde fois les écrans que le
 * tableau de bord porte déjà) et la liste de la barre latérale (les quatre
 * onglets ne disparaissent QUE s'ils sont devenus des colonnes).
 *
 * Évalué dès l'import côté client (donc AVANT le premier rendu hydraté : pas de
 * bascule visible après coup), `false` au rendu serveur — qui ne sait rien de
 * l'écran. Une seule instance, une seule MediaQueryList pour toute l'app.
 */
import { browser } from '$app/environment';

const QUERY = '(min-width: 1400px) and (pointer: fine)';

class DeskState {
  #matches = $state(browser ? window.matchMedia(QUERY).matches : false);

  constructor() {
    if (!browser) return;
    // Pas de removeEventListener : ce store vit aussi longtemps que l'app.
    window.matchMedia(QUERY).addEventListener('change', (e) => {
      this.#matches = e.matches;
    });
  }

  /** Vrai quand le tableau de bord a la place de s'afficher (jamais sur iPhone ni iPad). */
  get is(): boolean {
    return this.#matches;
  }
}

export const desk = new DeskState();
