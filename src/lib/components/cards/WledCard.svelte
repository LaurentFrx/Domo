<script lang="ts">
  /**
   * Éclairage terrasse (WLED — QuinLed Dig-Uno V3) : composition.
   *
   * Le panneau de contrôle empilé a été remplacé par un objet + une feuille :
   *   - `WledTile`  — la tuile-lampe posée sur /pieces. Elle EST la lumière
   *     (couleur réelle du ruban, remplie jusqu'à la luminosité) ; glissé
   *     horizontal = luminosité, tap = feuille, plus l'interrupteur.
   *   - `WledSheet` — tout le reste (ambiances, musique, couleur, effet,
   *     lignes), avec la place de respirer, une décision à la fois.
   *
   * Le flux temps réel du mode Musique (SSE /api/wled/music/live, refcounté et
   * suspendu en arrière-plan dans le store) est ouvert ICI : la tuile en a
   * besoin pour sa légende et sa lueur qui respire, même feuille fermée.
   */
  import WledTile from './WledTile.svelte';
  import WledSheet from './WledSheet.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';

  let sheetOpen = $state(false);

  $effect(() => {
    wledMusic.openLive();
    return () => wledMusic.closeLive();
  });
</script>

<WledTile onopen={() => (sheetOpen = true)} />
<WledSheet open={sheetOpen} onClose={() => (sheetOpen = false)} />
