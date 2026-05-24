<script lang="ts">
  import { matter } from '$stores/matter.svelte';

  interface Props {
    nodeId: number;
    name?: string;
  }

  let { nodeId, name = `Volet ${nodeId}` }: Props = $props();

  const available = $derived(matter.isAvailable(nodeId));
  // On masque la dernière position connue sur un nœud hors ligne — sinon l'UI
  // laisse penser qu'on connaît son état actuel alors qu'on a juste un cache.
  const liftPercent = $derived(available ? matter.positionFor(nodeId) : null);
  const positionLabel = $derived(liftPercent === null ? '—' : `${liftPercent}%`);

  // Valeur du slider : on tolère `null` en affichant 0 mais on désactive le contrôle.
  const sliderValue = $derived(liftPercent ?? 0);

  function onSlide(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    matter.setPosition(nodeId, value);
  }

  // Couleur dynamique de la piste de slider (remplie jusqu'au pourcentage).
  const trackStyle = $derived(
    `background: linear-gradient(to right, var(--accent-500) 0%, var(--accent-500) ${sliderValue}%, rgba(255,255,255,0.12) ${sliderValue}%, rgba(255,255,255,0.12) 100%);`
  );
</script>

<div
  class="flex flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 transition-opacity"
  class:opacity-50={!available}
>
  <!-- Header : nom + indicateur disponibilité -->
  <div class="flex items-start justify-between">
    <span class="text-xs font-medium tracking-wider text-white uppercase">{name}</span>
    <div class="flex items-center gap-1.5">
      <span
        class="h-2 w-2 rounded-full"
        style:background-color={available ? 'var(--accent-500)' : 'var(--text-secondary)'}
      ></span>
      <span class="text-[10px] text-[var(--text-secondary)]">
        {available ? 'En ligne' : 'Hors ligne'}
      </span>
    </div>
  </div>

  <!-- Slider position -->
  <div class="flex flex-col gap-1.5">
    <input
      type="range"
      min="0"
      max="100"
      step="1"
      value={sliderValue}
      disabled={!available}
      class="volet-slider"
      style={trackStyle}
      oninput={onSlide}
      aria-label="Position {name}"
    />
    <div class="flex justify-between text-[10px] text-[var(--text-secondary)]">
      <span>Fermé</span>
      <span class="text-white">{positionLabel}</span>
      <span>Ouvert</span>
    </div>
  </div>

  <!-- Boutons ouvrir / stop / fermer -->
  <div class="grid grid-cols-3 gap-2">
    <button
      type="button"
      class="volet-btn"
      disabled={!available}
      onclick={() => matter.openShutter(nodeId)}
      aria-label="Ouvrir {name}"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 15l6-6 6 6"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      type="button"
      class="volet-btn"
      disabled={!available}
      onclick={() => matter.stopShutter(nodeId)}
      aria-label="Arrêter {name}"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="1.5" />
      </svg>
    </button>
    <button
      type="button"
      class="volet-btn"
      disabled={!available}
      onclick={() => matter.closeShutter(nodeId)}
      aria-label="Fermer {name}"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
</div>

<style>
  /* Slider Yeldra — piste fine, thumb vert menthe */
  .volet-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    width: 100%;
    border-radius: 9999px;
    outline: none;
    transition: opacity var(--motion-base) var(--easing-default);
    cursor: pointer;
  }

  .volet-slider:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .volet-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    background-color: var(--accent-500);
    border: 2px solid var(--surface-card);
    box-shadow: 0 0 8px rgba(61, 253, 152, 0.45);
    cursor: grab;
    transition: transform var(--motion-fast) var(--easing-default);
  }

  .volet-slider::-webkit-slider-thumb:active {
    cursor: grabbing;
    transform: scale(1.1);
  }

  .volet-slider::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    background-color: var(--accent-500);
    border: 2px solid var(--surface-card);
    box-shadow: 0 0 8px rgba(61, 253, 152, 0.45);
    cursor: grab;
  }

  .volet-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 0;
    border-radius: 0.75rem;
    background-color: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
    transition: background-color var(--motion-fast) var(--easing-default);
  }

  .volet-btn:hover:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.15);
  }

  .volet-btn:active:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.2);
  }

  .volet-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
