<script lang="ts">
  /**
   * Éclairage terrasse (WLED — QuinLed Dig-Uno V3) : composition.
   *
   * Le panneau de contrôle empilé a été remplacé par un objet + une feuille :
   *   - `WledTile`  — la tuile-lampe posée sur /pieces. Elle EST la lumière
   *     (couleur réelle du ruban, remplie jusqu'à la luminosité) ; glissé
   *     horizontal = luminosité, tap = feuille, plus l'interrupteur.
   *   - `WledSheet` — tout le reste (ambiances, musique, couleur, effet,
   *     lignes). Elle n'est PAS rendue ici : /pieces vit dans le rail du
   *     Pager (`will-change: transform` + `overflow: hidden`), qui piège tout
   *     `position: fixed` — une modale montée ici s'ouvre hors écran. La
   *     feuille est donc montée dans +layout.svelte et ouverte via l'état
   *     partagé `wled-sheet-state` (pattern MenuSheet / TempHistorySheet).
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
