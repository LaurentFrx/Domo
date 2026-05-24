<script lang="ts">
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';

  interface Props {
    shutter: Shutter;
  }

  let { shutter }: Props = $props();

  // ─── Convention Matter (à ne pas modifier) ───
  // shutter.position = % de fermeture (0 = ouvert, 100 = fermé)
  //
  // ─── Rendu visuel cohérent avec un vrai volet vu de l'extérieur ───
  // Ouvert (0)  → tablier remonté → fill height = 0 %  → thumb tout EN HAUT
  // Fermé (100) → tablier déroulé → fill height = 100 % → thumb tout EN BAS
  //
  // Donc `slider-fill.height = position%` (le fill matérialise le tablier
  // visible), et `slider-thumb.bottom = (100 - position)%` (le thumb suit le
  // bas du tablier qui descend quand on ferme).

  let dragging = $state(false);
  // dragPos n'est utilisé que tant que `dragging === true` — il est écrasé par
  // pointerToPosition() dès le onPointerDown, donc l'initialiser à 0 suffit.
  let dragPos = $state(0);
  let trackEl = $state<HTMLDivElement | null>(null);

  // Affichage : si on drag, on suit le doigt, sinon on suit la valeur réelle.
  const displayedPosition = $derived(dragging ? dragPos : shutter.position);

  const positionLabel = $derived(
    displayedPosition <= 1 ? 'Ouvert' : displayedPosition >= 99 ? 'Fermé' : `${displayedPosition}%`
  );

  // Icône thumb : franche aux extrêmes, neutre entre les deux.
  const thumbIcon = $derived(displayedPosition <= 10 ? '☀️' : displayedPosition >= 90 ? '🌙' : '▬');

  function clampPosition(p: number): number {
    return Math.max(0, Math.min(100, p));
  }

  function pointerToPosition(clientY: number): number {
    if (!trackEl) return shutter.position;
    const rect = trackEl.getBoundingClientRect();
    // y relative en haut du track : 0 = top, height = bottom
    const yFromTop = clientY - rect.top;
    // Convertit en % de fermeture (top = 0 = ouvert, bottom = 100 = fermé)
    const closedPercent = (yFromTop / rect.height) * 100;
    return clampPosition(Math.round(closedPercent));
  }

  function onPointerDown(e: PointerEvent) {
    if (!shutter.available) return;
    dragging = true;
    dragPos = pointerToPosition(e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    e.preventDefault();
    dragPos = pointerToPosition(e.clientY);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const finalPos = pointerToPosition(e.clientY);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    // N'envoie la commande qu'à la fin du drag — économise les frames Matter.
    matter.goToPosition(shutter.nodeId, finalPos);
  }
</script>

<div
  class="tile-glass relative flex flex-col gap-3 overflow-hidden rounded-3xl p-4"
  class:opacity-50={!shutter.available}
>
  <!-- Glow décoratif vert menthe en haut à droite -->
  <div class="glow" aria-hidden="true"></div>

  <!-- Header : nom + room + pastille statut -->
  <div class="relative flex items-start justify-between">
    <div class="flex flex-col">
      <span class="text-sm leading-tight font-medium text-white">{shutter.name}</span>
      <span class="text-[10px] tracking-wider text-[var(--text-secondary)] uppercase">
        {shutter.room}
      </span>
    </div>
    <div class="flex items-center gap-1.5">
      {#if shutter.moving}
        <span class="text-[9px] font-medium text-[var(--primary-400)]">●●●</span>
      {/if}
      <span
        class="h-2 w-2 rounded-full"
        style:background-color={shutter.available ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      ></span>
    </div>
  </div>

  <!-- Slider vertical + indicateur valeur -->
  <div class="relative flex items-center gap-4">
    <!-- Track -->
    <div
      bind:this={trackEl}
      class="slider-track"
      class:dragging
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      role="slider"
      tabindex={shutter.available ? 0 : -1}
      aria-label="Position {shutter.name}"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={shutter.position}
      aria-valuetext={positionLabel}
    >
      <!-- Tablier visible : ancré en haut, descend du haut vers le bas avec
           la fermeture. height = position% (0 = invisible, 100 = plein rail). -->
      <div class="slider-fill" style:height="{displayedPosition}%"></div>
      <!-- Thumb (= bas du tablier / poignée), monte quand on ouvre. Ancré
           par le bas pour éviter d'aller calculer la hauteur du rail en JS.
           18px = thumbHeight / 2 pour centrer le thumb sur la limite tablier. -->
      <div class="slider-thumb" style:bottom="calc({100 - displayedPosition}% - 18px)">
        <span class="thumb-icon">{thumbIcon}</span>
      </div>
    </div>

    <!-- Valeur + état (à droite du slider) -->
    <div class="flex flex-1 flex-col gap-1">
      <span class="percent-display text-3xl leading-none font-bold">
        {displayedPosition}<span class="text-lg">%</span>
      </span>
      <span class="text-[11px] text-[var(--text-secondary)]">{positionLabel}</span>
    </div>
  </div>

  <!-- Boutons d'action discrets -->
  <div class="relative grid grid-cols-3 gap-1.5">
    <button
      type="button"
      class="action-btn"
      disabled={!shutter.available}
      onclick={() => matter.open(shutter.nodeId)}
      aria-label="Ouvrir {shutter.name}"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M18 15l-6-6-6 6"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      type="button"
      class="action-btn action-btn--stop"
      disabled={!shutter.available}
      onclick={() => matter.stop(shutter.nodeId)}
      aria-label="Arrêter {shutter.name}"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </svg>
    </button>
    <button
      type="button"
      class="action-btn"
      disabled={!shutter.available}
      onclick={() => matter.close(shutter.nodeId)}
      aria-label="Fermer {shutter.name}"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
  /* ─── Card en verre Yeldra ─── */
  .tile-glass {
    background: linear-gradient(135deg, rgba(48, 45, 58, 0.85) 0%, rgba(48, 45, 58, 0.65) 100%);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border: 1px solid var(--border-subtle);
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transition:
      box-shadow var(--motion-base) var(--easing-default),
      transform var(--motion-base) var(--easing-default);
  }

  .tile-glass:hover {
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.45),
      0 0 24px rgba(61, 253, 152, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  /* Halo accent en arrière-plan */
  .glow {
    position: absolute;
    top: -40px;
    right: -40px;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(61, 253, 152, 0.18), transparent 70%);
    pointer-events: none;
    z-index: 0;
  }

  /* ─── Slider vertical ─── */
  .slider-track {
    position: relative;
    width: 44px;
    height: 140px;
    border-radius: 24px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 4px 12px rgba(0, 0, 0, 0.5);
    cursor: grab;
    flex-shrink: 0;
    touch-action: none; /* indispensable pour pointer events tactiles */
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    overflow: hidden;
  }

  .slider-track.dragging {
    cursor: grabbing;
  }

  .slider-track:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 2px;
  }

  /* Tablier du volet — descend du haut (ancré top) avec la fermeture.
     Gradient vert néon Yeldra avec glow, comme avant. */
  .slider-fill {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to bottom, var(--accent-600), var(--accent-500));
    box-shadow:
      0 0 16px rgba(61, 253, 152, 0.55),
      0 0 4px rgba(141, 253, 195, 0.4);
    transition: height 250ms var(--easing-default);
    pointer-events: none;
  }

  .slider-track.dragging .slider-fill {
    transition: none;
  }

  /* Le pouce — neutre par défaut, halo accent uniquement pendant le drag. */
  .slider-thumb {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff, #e8e6f0);
    box-shadow:
      0 4px 10px rgba(0, 0, 0, 0.55),
      inset 0 -2px 4px rgba(0, 0, 0, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    transition: bottom 250ms var(--easing-default);
    will-change: bottom;
    z-index: 1;
  }

  .slider-track.dragging .slider-thumb {
    transition: none;
    box-shadow:
      0 6px 14px rgba(0, 0, 0, 0.7),
      0 0 22px rgba(61, 253, 152, 0.55);
  }

  .thumb-icon {
    font-size: 1rem;
    line-height: 1;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.4));
  }

  /* ─── Pourcentage en gros, gradient signature Yeldra ─── */
  .percent-display {
    background: linear-gradient(135deg, var(--accent-500), var(--primary-400));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.5px;
  }

  /* ─── Boutons d'action ─── */
  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0;
    border-radius: 0.75rem;
    background-color: rgba(255, 255, 255, 0.06);
    color: var(--text-primary);
    border: 1px solid rgba(255, 255, 255, 0.04);
    transition:
      background-color var(--motion-fast) var(--easing-default),
      border-color var(--motion-fast) var(--easing-default);
  }

  .action-btn:hover:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .action-btn:active:not(:disabled) {
    background-color: rgba(255, 255, 255, 0.18);
  }

  .action-btn:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }

  .action-btn--stop {
    color: var(--warning);
  }
</style>
