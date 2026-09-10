/**
 * « Sommes-nous sur un poste de bureau ? » — même définition que le variant CSS
 * `desk:` (src/app.css) : au moins 1 280 px de large ET un pointeur fin.
 *
 * Il existe parce qu'une media query CSS ne peut pas décider ce qu'on MONTE :
 * l'accueil rend le tableau de bord à quatre colonnes sur un écran de bureau et
 * la pile d'énergie ailleurs — les monter tous les deux pour en masquer un
 * ferait tourner le polling de Climat, Pièces et Musique sur un iPhone.
 *
 * Évalué dès l'import côté client (donc AVANT le premier rendu hydraté : pas de
 * bascule visible après coup), `false` au rendu serveur — qui ne sait rien de
 * l'écran. Une seule instance, une seule MediaQueryList pour toute l'app.
 */
import { browser } from '$app/environment';

const QUERY = '(min-width: 1280px) and (pointer: fine)';

class DeskState {
  #matches = $state(browser ? window.matchMedia(QUERY).matches : false);

  constructor() {
    if (!browser) return;
    // Pas de removeEventListener : ce store vit aussi longtemps que l'app.
    window.matchMedia(QUERY).addEventListener('change', (e) => {
      this.#matches = e.matches;
    });
  }

  /** Vrai sur un vrai poste de travail (jamais sur iPhone ni iPad). */
  get is(): boolean {
    return this.#matches;
  }
}

export const desk = new DeskState();
