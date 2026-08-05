/**
 * Action « portail » : re-parente le nœud vers l'ancre #layout-modal-root
 * posée en fin de +layout.svelte.
 *
 * Raison d'être : les pages du Pager sont rendues DANS le rail (`.pager-rail`,
 * `will-change: transform` permanent). Un ancêtre transformé devient le
 * référentiel des `position: fixed` de ses descendants : une modale montée
 * dans la page s'ancre alors au RAIL (haut de la page longue), pas au
 * viewport — cf. wled-sheet-state.svelte.ts. Quand la surface est un
 * composant autonome, on la monte dans +layout.svelte (pattern MenuSheet /
 * TempHistorySheet / WledSheet) ; quand elle est tissée dans l'état local
 * d'une page (formulaires, confirmations — cas de /musique), ce portail
 * déplace le DOM sans déplacer la logique.
 *
 * ⚠️ La cible DOIT rester dans l'arbre monté par Svelte (le <div> racine de
 * +layout.svelte), PAS document.body : l'app est hydratée dans un conteneur
 * enfant de <body>, et Svelte 5 délègue click/input/etc. à ce conteneur — un
 * nœud sorti de l'arbre n'appellerait plus aucun de ses handlers. L'ancre
 * dans le <div> racine conserve aussi l'enfoncement + haptique iOS délégués
 * du layout. Les styles scopés suivent le nœud (classes de hachage Svelte).
 */
export const PORTAL_TARGET_ID = 'layout-modal-root';

export function portal(node: HTMLElement) {
  // Sans ancre (ne devrait pas arriver), le nœud reste en place : c'est le
  // comportement d'avant le portail, dégradé mais fonctionnel.
  document.getElementById(PORTAL_TARGET_ID)?.appendChild(node);
  return {
    destroy() {
      node.remove();
    }
  };
}
