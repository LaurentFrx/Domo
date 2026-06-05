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

  const DEFAULT_SPEED_PCT_PER_SEC = 10;
  let animPos = $state<number | null>(null);
  let animTarget = 0;
  let lastFrameTime = 0;
  let rafId: number | null = null;
  let lastServerPos: number | null = null;

  let activeAction = $state<'open' | 'close' | 'stop' | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  // Direction du mouvement en cours — utilisé pour le glow néon du bouton
  // correspondant pendant TOUTE la durée du déplacement (vs activeAction
  // qui est purement temporaire 1.5s pour le fill plein).
  let movingDirection = $state<'open' | 'close' | null>(null);

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
    displayedPosition <= 1
      ? (shutter.labelMin ?? 'Ouvert')
      : displayedPosition >= 99
        ? (shutter.labelMax ?? 'Fermé')
        : `${displayedPosition}%`
  );

  const isMoving = $derived(animPos !== null || shutter.moving);

  // Dimensions proportionnelles via container queries (cqw). Pour les calculs
  // de drag : on lit la taille runtime du track (qui = la taille du thumb).
  function thumbSizePx(): number {
    return trackEl?.clientWidth ?? 32;
  }

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
    // Vitesse calée sur le temps de course réel si le store est bridé (travelMs),
    // sinon vitesse par défaut → affichage synchronisé avec le déplacement physique.
    const speed = shutter.travelMs ? 100_000 / shutter.travelMs : DEFAULT_SPEED_PCT_PER_SEC;
    const next = animPos + direction * speed * dt;
    const reached = (direction > 0 && next >= animTarget) || (direction < 0 && next <= animTarget);
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
    movingDirection = null;
  }

  // Si le serveur indique que le mouvement est terminé (shutter.moving = false
  // ET animPos null), couper le glow.
  $effect(() => {
    if (!isMoving) movingDirection = null;
  });

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
    const thumb = thumbSizePx();
    const half = thumb / 2;
    const usable = rect.height - thumb;
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
    const dir = finalPos < shutter.position ? 'open' : 'close';
    setActive(dir);
    movingDirection = dir;
    haptic('light');
    animPos = finalPos;
    animTarget = finalPos;
    scheduleFailsafeRelease();
    dragging = false;
  }

  function onOpenClick() {
    matter.open(shutter.nodeId);
    setActive('open');
    movingDirection = 'open';
    haptic('medium');
    setVisualTarget(0);
  }
  function onCloseClick() {
    matter.close(shutter.nodeId);
    setActive('close');
    movingDirection = 'close';
    haptic('medium');
    setVisualTarget(100);
  }
  function onStopClick() {
    matter.stop(shutter.nodeId);
    setActive('stop');
    movingDirection = null;
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
  <!-- Nom de la pièce (statut implicite via la position du thumb).
       Le wrap est autorisé pour les noms longs sur iPhone (Salle à manger…). -->
  <span
    class="shutter-name text-center leading-tight font-semibold"
    style="color: var(--color-fg);"
  >
    {shutter.name}
    {#if isMoving}
      <span class="moving-dots ml-1" style="color: var(--color-primary);">●●●</span>
    {/if}
  </span>

  <!-- Corps centré : slider fin (24px) + gap + colonne actions carrées (60px). Body 210px = 3×60 + 2×15 gap. -->
  <div class="shutter-body flex items-stretch justify-center gap-3">
    <div
      bind:this={trackEl}
      class="slider-track"
      class:dragging
    >
      <div class="slider-fill" style:height="{displayedPosition}%"></div>
      <!-- Le thumb (rond blanc) seul est draggable ET porte la sémantique slider
           (role + aria + focus), puisque c'est lui qui reçoit les gestes. Le reste
           du track laisse passer le scroll de l'iPhone (touch-action: pan-y). -->
      <div
        class="slider-thumb"
        role="slider"
        tabindex={shutter.available ? 0 : -1}
        aria-label="Position {shutter.name}"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={shutter.position}
        aria-valuetext={positionLabel}
        style:bottom="calc((100% - var(--ssize)) * {(100 - displayedPosition) / 100})"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        {#if displayedPosition > 1 && displayedPosition < 99}
          <span class="thumb-pct">{displayedPosition}</span>
        {/if}
      </div>
    </div>

    <div class="actions-col flex flex-col justify-between">
      <button
        type="button"
        class="action-btn action-btn--open"
        class:action-active={activeAction === 'open'}
        class:action-moving={movingDirection === 'open'}
        disabled={!shutter.available}
        onclick={onOpenClick}
        aria-label="Ouvrir {shutter.name}"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
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
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button
        type="button"
        class="action-btn action-btn--close"
        class:action-active={activeAction === 'close'}
        class:action-moving={movingDirection === 'close'}
        disabled={!shutter.available}
        onclick={onCloseClick}
        aria-label="Fermer {shutter.name}"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 19 L4 6 L20 6 Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  /* ─── Dimensions par CSS vars — palier mobile compact pour tenir à 3 cols ─── */
  .shutter-tile {
    --ssize: 24px; /* slider track + thumb */
    --bsize: 60px; /* bouton carré */
    --body-h: 210px; /* 3 × 60 + 2 × 15 gap */
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  @media (max-width: 639px) {
    .shutter-tile {
      --ssize: 20px;
      --bsize: 44px;
      --body-h: 150px; /* 3 × 44 + 2 × 9 gap */
    }
  }
  .shutter-tile:hover {
    border-color: var(--color-border-strong);
  }

  .shutter-name {
    font-size: 13px;
    line-height: 1.2;
    text-align: center;
    /* Wrap autorisé UNIQUEMENT aux espaces (jamais dans un mot) :
       'parents' reste entier, le browser choisit la coupure naturelle. */
    white-space: normal;
    word-break: keep-all;
    overflow-wrap: normal;
    hyphens: none;
    /* Réserve 2 lignes même pour les noms courts (Salon, Balcon) :
       toutes les cards alignées peu importe la longueur du nom. */
    min-height: 2.4em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  @media (max-width: 639px) {
    .shutter-name {
      font-size: 12px;
    }
  }

  .moving-dots {
    animation: pulse-dots 1.2s ease-in-out infinite;
    font-size: 8px;
    letter-spacing: -2px;
  }
  @keyframes pulse-dots {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  .shutter-body {
    height: var(--body-h);
  }

  /* ─── Slider vertical — width = --ssize. Track laisse passer le scroll. ─── */
  .slider-track {
    position: relative;
    width: var(--ssize);
    height: 100%;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    flex-shrink: 0;
    /* pan-y : iOS Safari scrolle la page si le geste est vertical sur le track */
    touch-action: pan-y;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    overflow: visible; /* permet à la hit-area étendue du thumb de déborder */
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
    /* Le track est overflow:visible (pour le hit-area du thumb), donc le fill
       doit gérer son propre arrondi pour matcher la forme du track. */
    border-radius: 9999px;
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
    width: var(--ssize);
    height: var(--ssize);
    border-radius: 50%;
    background: #ffffff;
    box-shadow:
      0 2px 6px oklch(0 0 0 / 0.18),
      0 1px 2px oklch(0 0 0 / 0.1);
    pointer-events: auto;
    cursor: grab;
    /* drag : empêche le browser de consumer le geste vertical */
    touch-action: none;
    transition: bottom 120ms linear;
    will-change: bottom;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: oklch(0.3 0.01 280);
    -webkit-tap-highlight-color: transparent;
  }
  .slider-track.dragging .slider-thumb {
    cursor: grabbing;
  }
  /* Hit-area étendue invisible 44×44 (HIG iOS) autour du thumb */
  .slider-thumb::before {
    content: '';
    position: absolute;
    inset: -10px;
  }
  .thumb-pct {
    font-size: 10px;
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

  /* ─── Boutons carrés — width = height = --bsize ─── */
  .actions-col {
    width: var(--bsize);
  }
  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--bsize);
    height: var(--bsize);
    border-radius: var(--radius-lg);
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: all var(--duration-fast) var(--ease-default);
  }
  .action-btn svg {
    width: 38%;
    height: 38%;
  }
  .action-btn--stop svg {
    width: 30%;
    height: 30%;
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

  /* ─── Glow néon pendant que le moteur tourne (idem switches ON) ─── */
  .action-btn.action-moving {
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .action-btn--open.action-moving {
    border-color: var(--color-battery);
    box-shadow:
      0 0 14px color-mix(in oklch, var(--color-battery) 50%, transparent),
      0 0 32px color-mix(in oklch, var(--color-battery) 22%, transparent);
  }
  .action-btn--close.action-moving {
    border-color: var(--color-primary);
    box-shadow:
      0 0 14px color-mix(in oklch, var(--color-primary) 50%, transparent),
      0 0 32px color-mix(in oklch, var(--color-primary) 22%, transparent);
  }
</style>
