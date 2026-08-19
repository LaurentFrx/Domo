<script lang="ts">
  /**
   * Carte « Terrasse » : le ruban WLED (QuinLed Dig-Uno V3), rendu par
   * `WledTile` — la tuile EST la lumière (couleur réelle, remplie jusqu'à la
   * luminosité) ; glissé horizontal = luminosité, tap = feuille.
   *
   * `WledSheet` n'est PAS rendue ici : /pieces vit dans le rail du Pager
   * (`will-change: transform` + `overflow: hidden`), qui piège tout
   * `position: fixed` — une modale montée ici s'ouvrirait hors écran. La
   * feuille est montée dans +layout.svelte et ouverte via l'état partagé
   * `wled-sheet-state` (pattern MenuSheet / TempHistorySheet).
   *
   * Le flux temps réel du mode Musique (SSE /api/wled/music/live, refcounté et
   * suspendu en arrière-plan dans le store) est ouvert ICI : la tuile en a
   * besoin pour sa légende et sa lueur qui respire, même feuille fermée.
   */
  import WledTile from './WledTile.svelte';
  import { openWledSheet } from './wled-sheet-state.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';

  $effect(() => {
    wledMusic.openLive();
    return () => wledMusic.closeLive();
  });
</script>

<WledTile onopen={openWledSheet} />
