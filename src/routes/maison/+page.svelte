<script lang="ts">
  import { browser } from '$app/environment';

  // ─── Chargement différé du bundle 3D ────────────────────────────────────
  // three.js + Threlte ne doivent JAMAIS entrer dans le chunk initial de
  // l'app : l'import() dynamique laisse Vite les isoler dans un chunk dédié,
  // chargé seulement à l'ouverture de /maison. Gardé `browser` pour que le
  // SSR ne charge pas three côté serveur (la promesse n'existe qu'au client).
  const dollhouse = browser ? import('$components/dollhouse/Dollhouse3D.svelte') : null;
</script>

<svelte:head>
  <title>Maison · Domo</title>
</svelte:head>

{#snippet loading()}
  <div class="flex h-full flex-col items-center justify-center gap-3">
    <span class="loader-ring" aria-hidden="true"></span>
    <p class="text-[13px]" style="color: var(--color-muted-fg);">Chargement de la maquette 3D…</p>
  </div>
{/snippet}

<div class="flex flex-col gap-4 py-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Maison</h1>
    <span class="text-[12px]" style="color: var(--color-muted-fg);"> Plan 3D · pièces </span>
  </header>

  <!-- Coque de la scène : carte verre Domo (l'arête/ombre plexiglass vient du
       mécanisme centralisé app.css). Le canvas Threlte, transparent, remplit
       la hauteur restante du viewport — TabBar et safe-areas déjà compensées
       par le layout, on ne déduit ici que le titre et les paddings de page. -->
  <div
    class="scene-shell relative overflow-hidden rounded-2xl border"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    {#if dollhouse}
      {#await dollhouse}
        {@render loading()}
      {:then mod}
        {@const Dollhouse3D = mod.default}
        <Dollhouse3D />
      {:catch error}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p class="text-[14px] font-semibold">La scène 3D n'a pas pu se charger</p>
          <p class="text-[12px]" style="color: var(--color-muted-fg);">
            {error?.message ?? 'Erreur inconnue'}
          </p>
        </div>
      {/await}
    {:else}
      <!-- SSR : même placeholder, remplacé à l'hydratation -->
      {@render loading()}
    {/if}
  </div>
</div>

<style>
  .scene-shell {
    /* Hauteur restante : le layout compense déjà safe-top et TabBar
       (60px + safe-bottom) ; on déduit titre + gaps + paddings (~5.5rem). */
    height: calc(100dvh - env(safe-area-inset-top) - 60px - env(safe-area-inset-bottom) - 5.5rem);
    min-height: 320px;
  }

  /* sm+ : la TabBar est masquée, son padding est annulé par le layout */
  @media (min-width: 640px) {
    .scene-shell {
      height: calc(100dvh - env(safe-area-inset-top) - 5.5rem);
    }
  }

  .loader-ring {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2.5px solid var(--color-border);
    border-top-color: var(--color-primary);
    animation: ring-spin 0.8s linear infinite;
  }

  @keyframes ring-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loader-ring {
      animation: none;
      border-top-color: var(--color-border);
      border-color: var(--color-primary);
      opacity: 0.6;
    }
  }
</style>
