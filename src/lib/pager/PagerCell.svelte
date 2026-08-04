<script lang="ts">
  /**
   * Cellule d'aperçu du pager : monte le VRAI composant de page d'une voisine
   * (via le registre lazy) pour qu'on voie son contenu défiler pendant le glissé.
   *
   * (Le cas particulier « ne pas monter la 3D de /maison en aperçu » a disparu avec
   * la sortie de /maison de la navigation : la page n'est plus une voisine du pager.)
   *
   * Le composant de page acquiert ses stores au montage (refcount, cf.
   * $stores/refcount) → polling partagé, pas de duplication.
   */
  import type { Component } from 'svelte';
  import { loaderFor } from '$lib/pager/page-registry';

  let { href }: { href: string } = $props();

  let Comp = $state<Component | null>(null);
  $effect(() => {
    let cancelled = false;
    Comp = null;
    loaderFor(href)?.().then((m) => {
      if (!cancelled) Comp = m.default;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if Comp}
  <Comp />
{/if}
