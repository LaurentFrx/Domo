/**
 * État d'ouverture de la feuille de réglages terrasse. Module-level, comme
 * `menu-state` : la tuile (dans /pieces) l'ouvre, la feuille montée UNE FOIS
 * dans +layout.svelte la rend.
 *
 * Raison d'être — et piège à ne pas recréer : /pieces est rendue DANS le rail
 * du Pager, qui porte `will-change: transform` en permanence. Un ancêtre
 * transformé devient le référentiel des `position: fixed` de ses descendants :
 * une feuille modale montée dans la page s'ancre alors au RAIL (haut de la
 * page longue), pas au viewport — elle s'ouvrait hors écran, au-dessus de la
 * zone visible, dès que l'utilisateur avait défilé jusqu'à la tuile. Les
 * cellules voisines ont en plus `overflow: hidden`. Toute surface modale
 * appelée depuis une page du Pager DOIT donc être montée dans le layout
 * (pattern MenuSheet / TempHistorySheet), jamais dans la page.
 */
export const wledSheet = $state<{ open: boolean }>({ open: false });

export function openWledSheet() {
  wledSheet.open = true;
}
export function closeWledSheet() {
  wledSheet.open = false;
}
