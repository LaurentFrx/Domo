<script lang="ts">
  import { onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    shutter: Shutter;
  }

  let { shutter }: Props = $props();

  // ─── Convention Matter (à ne pas modifier) ───
  // shutter.position = % de fermeture (0 = ouvert, 100 = fermé)

  let dragging = $state(false);
  let dragPos = $state(0);
  let trackEl = $state<HTMLDivElement | null>(null);

  const SPEED_PERCENT_PER_SECOND = 10;
  let animPos = $state<number | null>(null);
  let animTarget = 0;
  let lastFrameTime = 0;
  let rafId: number | null = null;
  let lastServerPos: number | null = null;

  let activeAction = $state<'open' | 'close' | 'stop' | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  function setActive(action: 'open' | 'close' | 'stop') {
    activeAction = action;
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => {
      activeAction = null;
    }, 1500);
  }

  const displayedPosition = $derived(
    dragging ? dragPos : animPos !== null ? Math.round(animPos) : shutter.position
  );

  const positionLabel = $derived(
    displayedPosition <= 1 ? 'Ouvert' : displayedPosition >= 99 ? 'Fermé' : `${displayedPosition}%`
  );

  const isMoving = $derived(animPos !== null || shutter.moving);

  // Slider 40×230 — thumb 40px pour rentrer dans la card avec les boutons 70px
  const THUMB_SIZE = 40;

  $effect(() => {
    const pos = shutter.position;
    if (lastServerPos === null) {
      lastServerPos = pos;
      return;
    }
    if (pos === lastServerPos) return;
    lastServerPos = pos;
    if (animPos === null) return;
    if (Math.abs(pos - animTarget) < 2) {
      stopAnimation();
      return;
    }
    if (Math.abs(pos - animPos) > 10) {
      animPos = pos;
      lastFrameTime = performance.now();
      if (rafId === null && pos !== animTarget) {
        rafId = requestAnimationFrame(animTick);
      }
    }
  });

  function setVisualTarget(target: number) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    const from = dragging ? dragPos : (animPos ?? shutter.position);
    if (Math.abs(from - target) < 0.5) {
      animPos = null;
      return;
    }
    animPos = from;
    animTarget = target;
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(animTick);
  }

  function animTick(t: number) {
    rafId = null;
    if (animPos === null) return;
    const dt = (t - lastFrameTime) / 1000;
    lastFrameTime = t;
    const direction = animTarget > animPos ? 1 : -1;
    const next = animPos + direction * SPEED_PERCENT_PER_SECOND * dt;
    const reached =
      (direction > 0 && next >= animTarget) || (direction < 0 && next <= animTarget);
    if (reached) {
      animPos = animTarget;
      scheduleFailsafeRelease();
      return;
    }
    animPos = next;
    rafId = requestAnimationFrame(animTick);
  }

  let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFailsafeRelease() {
    if (failsafeTimer) clearTimeout(failsafeTimer);
    failsafeTimer = setTimeout(() => {
      failsafeTimer = null;
      if (rafId === null && animPos === animTarget) {
        animPos = null;
      }
    }, 20000);
  }

  function stopAnimation() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (failsafeTimer) {
      clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }
    animPos = null;
  }

  onDestroy(() => {
    stopAnimation();
    if (activeTimer) clearTimeout(activeTimer);
    if (failsafeTimer) clearTimeout(failsafeTimer);
  });

  function clampPosition(p: number): number {
    return Math.max(0, Math.min(100, p));
  }

  function pointerToPosition(clientY: number): number {
    if (!trackEl) return shutter.position;
    const rect = trackEl.getBoundingClientRect();
    const half = THUMB_SIZE / 2;
    const usable = rect.height - THUMB_SIZE;
    const yCentered = clientY - rect.top - half;
    const closedPercent = (yCentered / usable) * 100;
    return clampPosition(Math.round(closedPercent));
  }

  function onPointerDown(e: PointerEvent) {
    if (!shutter.available) return;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (failsafeTimer) {
      clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }
    animPos = null;
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
    const finalPos = pointerToPosition(e.clientY);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    matter.goToPosition(shutter.nodeId, finalPos);
    setActive(finalPos < shutter.position ? 'open' : 'close');
    haptic('light');
    animPos = finalPos;
    animTarget = finalPos;
    scheduleFailsafeRelease();
    dragging = false;
  }

  function onOpenClick() {
    matter.open(shutter.nodeId);
    setActive('open');
    haptic('medium');
    setVisualTarget(0);
  }
  function onCloseClick() {
    matter.close(shutter.nodeId);
    setActive('close');
    haptic('medium');
    setVisualTarget(100);
  }
  function onStopClick() {
    matter.stop(shutter.nodeId);
    setActive('stop');
    haptic('heavy');
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (animPos !== null) {
      animTarget = animPos;
      scheduleFailsafeRelease();
    }
  }

  const stateColor = $derived(
    displayedPosition <= 1
      ? 'var(--color-battery)'
      : displayedPosition >= 99
        ? 'var(--color-primary)'
        : 'var(--color-primary)'
  );
</script>

<div
  class="shutter-tile flex flex-col gap-2 rounded-[var(--radius-xl)] border p-3"
  class:opacity-50={!shutter.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="{shutter.name} — {positionLabel}"
>
  <!-- Nom de la pièce (uniquement, sans répétition du statut — il est dans le thumb) -->
  <span class="text-[12px] font-semibold leading-tight truncate text-center" style="color: var(--color-fg);">
    {shutter.name}
    {#if isMoving}
      <span class="moving-dots ml-1" style="color: var(--color-primary);">●●●</span>
    {/if}
  </span>

  <!-- Corps : slider vertical 230px à gauche + 3 actions carrées 70×70 équi-réparties -->
  <div class="flex items-stretch gap-3" style="height: 230px;">
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
      <div class="slider-fill" style:height="{displayedPosition}%"></div>
      <div
        class="slider-thumb"
        style:bottom="calc((100% - {THUMB_SIZE}px) * {(100 - displayedPosition) / 100})"
      >
        {#if displayedPosition > 1 && displayedPosition < 99}
          <span class="thumb-pct">{displayedPosition}</span>
        {/if}
      </div>
    </div>

    <div class="flex flex-col justify-between" style="width: 70px;">
      <button
        type="button"
        class="action-btn action-btn--open"
        class:action-active={activeAction === 'open'}
        disabled={!shutter.available}
        onclick={onOpenClick}
        aria-label="Ouvrir {shutter.name}"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5 L20 18 L4 18 Z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="action-btn action-btn--stop"
        class:action-active={activeAction === 'stop'}
        disabled={!shutter.available}
        onclick={onStopClick}
        aria-label="Arrêter {shutter.name}"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button
        type="button"
        class="action-btn action-btn--close"
        class:action-active={activeAction === 'close'}
        disabled={!shutter.available}
        onclick={onCloseClick}
        aria-label="Fermer {shutter.name}"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19 L4 6 L20 6 Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .shutter-tile {
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  .shutter-tile:hover {
    border-color: var(--color-border-strong);
  }

  .moving-dots {
    animation: pulse-dots 1.2s ease-in-out infinite;
    font-size: 8px;
    letter-spacing: -2px;
  }
  @keyframes pulse-dots {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* ─── Slider vertical (taille tactile iPad) ─── */
  .slider-track {
    position: relative;
    width: 40px;
    height: 100%;
    border-radius: 20px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: grab;
    flex-shrink: 0;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    overflow: hidden;
  }
  .slider-track.dragging {
    cursor: grabbing;
  }
  .slider-track:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .slider-fill {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to bottom, var(--color-primary), oklch(0.48 0.26 293));
    transition: height 120ms linear;
    pointer-events: none;
  }
  .slider-track.dragging .slider-fill {
    transition: none;
  }
  .slider-thumb {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow:
      0 2px 6px oklch(0 0 0 / 0.18),
      0 1px 2px oklch(0 0 0 / 0.10);
    pointer-events: none;
    transition: bottom 120ms linear;
    will-change: bottom;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: oklch(0.30 0.01 280);
  }
  .thumb-pct {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .slider-track.dragging .slider-thumb {
    transition: none;
    box-shadow:
      0 3px 10px oklch(0 0 0 / 0.25),
      0 0 0 3px var(--color-primary-muted);
  }

  /* ─── Actions carrées 70×70 — triangles colorés (vert open / violet close) ─── */
  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 70px;
    height: 70px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: all var(--duration-fast) var(--ease-default);
  }
  .action-btn--open {
    color: var(--color-battery);
  }
  .action-btn--close {
    color: var(--color-primary);
  }
  .action-btn--stop {
    color: var(--color-warning);
  }
  .action-btn:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .action-btn:active:not(:disabled) {
    transform: scale(0.94);
  }
  .action-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  /* État actif après tap : fill plein de la couleur sémantique */
  .action-active.action-btn--open {
    background: var(--color-battery);
    border-color: var(--color-battery);
    color: var(--color-primary-fg);
    box-shadow: 0 0 0 3px var(--color-battery-muted);
  }
  .action-active.action-btn--close {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-fg);
    box-shadow: 0 0 0 3px var(--color-primary-muted);
  }
  .action-active.action-btn--stop {
    background: var(--color-warning);
    border-color: var(--color-warning);
    color: var(--color-primary-fg);
  }
</style>
