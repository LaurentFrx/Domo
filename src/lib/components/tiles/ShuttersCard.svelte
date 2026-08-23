<script lang="ts">
  /**
   * ShuttersCard — UNE carte pour tous les volets roulants (23/08/2026) :
   * sur iPhone, 7 cartes empilées coûtaient ~520 px ; ici 7 rangées d'une ligne
   * (nom · état · barre · ▲ ■ ▼) séparées par un filet, ~300 px.
   * Dès l'iPad : la grille de sliders verticaux d'avant, dans la même carte,
   * avec « Tout ouvrir / Tout fermer » en tête (masqués sur iPhone, comme avant).
   * Chaque rangée reste un ShutterTile (logique de commande inchangée), en mode
   * `embedded` (sans carte propre).
   */
  import ShutterTile from './ShutterTile.svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    shutters: Shutter[];
    /** Afficher « Tout ouvrir / Tout fermer » (liaison Matter vivante). */
    showGlobal?: boolean;
  }
  let { shutters, showGlobal = false }: Props = $props();
</script>

<section
  class="shutters-card rounded-[var(--radius-xl)] border"
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Volets roulants"
>
  {#if showGlobal}
    <header class="hidden items-center justify-between gap-2 px-3 pt-3 sm:flex">
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);">Volets</span
      >
      <div class="flex gap-2">
        <button
          type="button"
          class="pill-open"
          onclick={() => {
            haptic('heavy');
            matter.openAll();
          }}
          aria-label="Ouvrir tous les volets"
        >
          <span aria-hidden="true">▲</span> Tout ouvrir
        </button>
        <button
          type="button"
          class="pill-close"
          onclick={() => {
            haptic('heavy');
            matter.closeAll();
          }}
          aria-label="Fermer tous les volets"
        >
          <span aria-hidden="true">▼</span> Tout fermer
        </button>
      </div>
    </header>
  {/if}
  <div class="rows" style="--shutter-count: {shutters.length};">
    {#each shutters as shutter (shutter.nodeId)}
      <ShutterTile {shutter} embedded />
    {/each}
  </div>
</section>

<style>
  .shutters-card {
    padding: 4px 0;
  }
  /* iPhone : rangées séparées par un filet discret. */
  .rows {
    display: flex;
    flex-direction: column;
  }
  .rows > :global(* + *) {
    border-top: 1px solid color-mix(in oklch, var(--color-border) 55%, transparent);
  }
  /* iPad+ : grille de sliders verticaux (auto-fit, puis N colonnes dès lg). */
  @media (min-width: 640px) {
    .shutters-card {
      padding: 0 8px 8px;
    }
    .rows {
      display: grid;
      gap: 0.375rem;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }
    .rows > :global(* + *) {
      border-top: 0;
    }
  }
  @media (min-width: 1024px) {
    .rows {
      grid-template-columns: repeat(var(--shutter-count, 6), minmax(0, 1fr));
    }
  }

  .pill-open,
  .pill-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    border: 1px solid transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .pill-open {
    color: var(--color-battery);
    background: var(--color-battery-muted);
    border-color: var(--color-battery);
  }
  .pill-open:hover {
    background: var(--color-battery);
    color: var(--color-primary-fg);
  }
  .pill-close {
    color: var(--color-primary);
    background: var(--color-primary-muted);
    border-color: var(--color-primary);
  }
  .pill-close:hover {
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .pill-open:active,
  .pill-close:active {
    transform: scale(0.97);
  }
</style>
