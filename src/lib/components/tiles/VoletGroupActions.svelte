<script lang="ts">
  import { matter } from '$stores/matter.svelte';

  interface Props {
    /** Identifiants des nœuds Matter à piloter en groupe. */
    nodeIds: number[];
    /** Variante d'affichage : `full` (3 boutons) ou `compact` (2 boutons). */
    variant?: 'full' | 'compact';
  }

  let { nodeIds, variant = 'full' }: Props = $props();

  function openAll() {
    for (const id of nodeIds) matter.openShutter(id);
  }
  function closeAll() {
    for (const id of nodeIds) matter.closeShutter(id);
  }
  function stopAll() {
    for (const id of nodeIds) matter.stopShutter(id);
  }
</script>

<div class="flex flex-wrap gap-2">
  <button type="button" class="pill" onclick={openAll}>Tout ouvrir</button>
  <button type="button" class="pill" onclick={closeAll}>Tout fermer</button>
  {#if variant === 'full'}
    <button type="button" class="pill" onclick={stopAll}>Tout arrêter</button>
  {/if}
</div>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 1rem;
    border-radius: 9999px;
    border: 1px solid var(--border-default);
    background-color: transparent;
    color: var(--text-primary);
    font-size: 0.8125rem;
    font-weight: 500;
    transition:
      background-color var(--motion-fast) var(--easing-default),
      border-color var(--motion-fast) var(--easing-default);
  }

  .pill:hover {
    background-color: rgba(255, 255, 255, 0.06);
    border-color: var(--border-strong);
  }

  .pill:active {
    background-color: rgba(255, 255, 255, 0.1);
  }
</style>
