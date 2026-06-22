<script lang="ts">
  import { Canvas } from '@threlte/core';
  import MaisonScene from './MaisonScene.svelte';
</script>

<!-- Garde-fous iOS :
     · dpr borné [1, 2] → Threlte applique renderer.setPixelRatio(clamp(devicePixelRatio, 1, 2))
       (Retina 3× = surcoût GPU inutile sur iPhone) ;
     · resize géré par l'observer interne de Threlte, SANS recréation du contexte WebGL
       (ne pas envelopper <Canvas> d'un {#key} ni le remonter manuellement) ;
     · disposal automatique au démontage : les objets <T.*> et le renderer sont
       libérés par le contexte Threlte (disposableObject*) — rien à câbler ;
     · pas de post-processing.
     Le renderer Threlte est créé alpha:true → canvas transparent, la carte
     verre Domo reste visible derrière la scène. -->
<div class="h-full w-full">
  <Canvas dpr={[1, 2]}>
    <MaisonScene />
  </Canvas>
</div>
