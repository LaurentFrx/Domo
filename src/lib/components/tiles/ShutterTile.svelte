<script lang="ts">
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';

  interface Props {
    shutter: Shutter;
  }

  let { shutter }: Props = $props();

  let sliderValue = $state(shutter.position);
  let dragging = $state(false);

  // Sync slider with shutter position when not dragging
  $effect(() => {
    if (!dragging) {
      sliderValue = shutter.position;
    }
  });

  function onSliderInput(e: Event) {
    dragging = true;
    sliderValue = parseInt((e.target as HTMLInputElement).value);
  }

  function onSliderChange() {
    dragging = false;
    matter.goToPosition(shutter.nodeId, sliderValue);
  }

  const positionLabel = $derived(
    shutter.position === 0 ? 'Ouvert' : shutter.position >= 100 ? 'Fermé' : `${shutter.position}%`
  );

  const statusColor = $derived(shutter.available ? 'var(--accent-500)' : 'var(--text-tertiary)');
</script>

<div
  class="relative overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 transition-colors"
  class:opacity-50={!shutter.available}
>
  <!-- Header: name + status -->
  <div class="mb-3 flex items-start justify-between">
    <div class="flex flex-col">
      <span class="text-sm font-medium text-white">{shutter.name}</span>
      <span class="text-[10px] text-[var(--text-secondary)]">{shutter.room}</span>
    </div>
    <div class="flex items-center gap-1.5">
      {#if shutter.moving}
        <span class="text-[10px] font-medium text-[var(--primary-400)]">En mouvement</span>
      {/if}
      <span class="h-2 w-2 rounded-full" style="background-color: {statusColor};"></span>
    </div>
  </div>

  <!-- Position display -->
  <div class="mb-3 flex items-baseline gap-1">
    <span class="text-3xl font-light text-white">
      {dragging ? sliderValue : shutter.position}
    </span>
    <span class="text-sm text-[var(--text-secondary)]">%</span>
    <span class="ml-auto text-xs text-[var(--text-secondary)]">{positionLabel}</span>
  </div>

  <!-- Slider -->
  <div class="mb-3">
    <input
      type="range"
      min="0"
      max="100"
      step="5"
      value={sliderValue}
      disabled={!shutter.available}
      oninput={onSliderInput}
      onchange={onSliderChange}
      class="shutter-slider w-full"
      style="--val: {sliderValue}"
    />
  </div>

  <!-- Action buttons -->
  <div class="flex gap-1.5">
    <button
      type="button"
      class="flex flex-1 items-center justify-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-white/5 py-2 text-xs font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-30"
      disabled={!shutter.available}
      onclick={() => matter.open(shutter.nodeId)}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <path d="M18 15l-6-6-6 6" />
      </svg>
      Ouvrir
    </button>
    <button
      type="button"
      class="flex flex-1 items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-white/5 py-2 text-xs font-medium text-[var(--warning)] transition-colors hover:bg-white/10 disabled:opacity-30"
      disabled={!shutter.available}
      onclick={() => matter.stop(shutter.nodeId)}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
      >
        <rect x="6" y="6" width="12" height="12" rx="1" />
      </svg>
      Stop
    </button>
    <button
      type="button"
      class="flex flex-1 items-center justify-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-white/5 py-2 text-xs font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-30"
      disabled={!shutter.available}
      onclick={() => matter.close(shutter.nodeId)}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
      Fermer
    </button>
  </div>
</div>

<style>
  .shutter-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(
      to right,
      var(--accent-500) 0%,
      var(--accent-500) calc(var(--val, 0) * 1%),
      rgba(255, 255, 255, 0.1) calc(var(--val, 0) * 1%),
      rgba(255, 255, 255, 0.1) 100%
    );
    outline: none;
    cursor: pointer;
  }
  .shutter-slider:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }
  .shutter-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: white;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
  .shutter-slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 50%;
    background: white;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
</style>
