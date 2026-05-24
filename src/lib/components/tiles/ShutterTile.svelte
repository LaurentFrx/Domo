<script lang="ts">
  import { onDestroy } from 'svelte';
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

  // ─── Drag du slider ───
  let dragging = $state(false);
  let dragPos = $state(0);
  let trackEl = $state<HTMLDivElement | null>(null);

  // ─── Animation locale anticipée ───
  // Les SONOFF MINI-RBS ne pushent leur position qu'à la fin du mouvement.
  // Pour donner un feedback fluide, on anime localement de la position
  // actuelle vers la cible à ~10 secondes / 100% (vitesse typique d'un volet
  // roulant standard). On recalibre dès qu'un vrai event arrive.
  const SPEED_PERCENT_PER_SECOND = 10;
  let animPos = $state<number | null>(null);
  let animTarget = 0;
  let lastFrameTime = 0;
  let rafId: number | null = null;
  // Mémoire interne (non reactive) — sert juste à détecter les nouvelles
  // valeurs serveur dans l'effect, pas à déclencher du rendu.
  let lastServerPos: number | null = null;

  // ─── Glow boutons quand action en cours ───
  let activeAction = $state<'open' | 'close' | 'stop' | null>(null);
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  function setActive(action: 'open' | 'close' | 'stop') {
    activeAction = action;
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => {
      activeAction = null;
    }, 1500);
  }

  // ─── Position affichée (drag > anim > état serveur) ───
  const displayedPosition = $derived(
    dragging ? dragPos : animPos !== null ? Math.round(animPos) : shutter.position
  );

  const positionLabel = $derived(
    displayedPosition <= 1 ? 'Ouvert' : displayedPosition >= 99 ? 'Fermé' : `${displayedPosition}%`
  );

  const thumbIcon = $derived(displayedPosition <= 10 ? '☀️' : displayedPosition >= 90 ? '🌙' : '▬');

  const isMoving = $derived(animPos !== null || shutter.moving);

  // Recalibre l'animation locale quand le serveur push une vraie nouvelle
  // valeur (différente de la dernière qu'on connaissait).
  $effect(() => {
    const pos = shutter.position;
    if (lastServerPos === null) {
      lastServerPos = pos;
      return;
    }
    if (pos === lastServerPos) return;
    lastServerPos = pos;
    if (animPos === null) return;
    // Quasi-cible atteinte côté serveur → libère l'animation, on retombe
    // sur shutter.position.
    if (Math.abs(pos - animTarget) < 2) {
      stopAnimation();
      return;
    }
    // Écart important entre notre estimation locale et la réalité serveur
    // → on s'aligne sur la vérité, l'anim continue depuis ce point.
    if (Math.abs(pos - animPos) > 10) {
      animPos = pos;
      lastFrameTime = performance.now();
      if (rafId === null && pos !== animTarget) {
        rafId = requestAnimationFrame(animTick);
      }
    }
  });

  /**
   * Démarre / met à jour l'animation visuelle vers `target`.
   * Le point de départ est la position visuelle COURANTE (drag en cours,
   * anim en cours, ou état serveur) — ainsi pas de saut visuel quand on
   * lâche le slider ou qu'on re-clique pendant un mouvement.
   */
  function setVisualTarget(target: number) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    const from = dragging ? dragPos : (animPos ?? shutter.position);
    if (Math.abs(from - target) < 0.5) {
      // Déjà à la cible : pas d'anim, pas de pastille « en mouvement ».
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
    const reached = (direction > 0 && next >= animTarget) || (direction < 0 && next <= animTarget);
    if (reached) {
      // Cible visuelle atteinte. On garde animPos figé sur animTarget
      // jusqu'à ce que le serveur confirme — c'est le $effect qui libérera
      // animPos via stopAnimation(). Si le serveur ne confirme jamais
      // (rare), un filet de sécurité libère après 20 s.
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
      // Libère uniquement si l'anim est encore figée sur la cible.
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

  // ─── Drag du slider ───
  function clampPosition(p: number): number {
    return Math.max(0, Math.min(100, p));
  }

  function pointerToPosition(clientY: number): number {
    if (!trackEl) return shutter.position;
    const rect = trackEl.getBoundingClientRect();
    const yFromTop = clientY - rect.top;
    const closedPercent = (yFromTop / rect.height) * 100;
    return clampPosition(Math.round(closedPercent));
  }

  function onPointerDown(e: PointerEvent) {
    if (!shutter.available) return;
    // Interrompt l'anim en cours (sans casser la continuité visuelle :
    // on bascule directement sur dragPos via `dragging = true`).
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
    // « Hold » visuel sur finalPos jusqu'à confirmation serveur — set AVANT
    // dragging=false pour ne pas exposer brièvement shutter.position
    // (l'ancienne valeur).
    animPos = finalPos;
    animTarget = finalPos;
    scheduleFailsafeRelease();
    dragging = false;
  }

  // ─── Handlers boutons ───
  function onOpenClick() {
    matter.open(shutter.nodeId);
    setActive('open');
    setVisualTarget(0);
  }
  function onCloseClick() {
    matter.close(shutter.nodeId);
    setActive('close');
    setVisualTarget(100);
  }
  function onStopClick() {
    matter.stop(shutter.nodeId);
    setActive('stop');
    // Fige immédiatement le tablier sur la position visuelle courante.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (animPos !== null) {
      animTarget = animPos;
      scheduleFailsafeRelease();
    }
  }
</script>

<div
  class="tile-glass relative flex flex-col gap-3 overflow-hidden rounded-3xl p-4"
  class:opacity-50={!shutter.available}
>
  <div class="glow" aria-hidden="true"></div>

  <!-- Header : nom + pastille statut (room retiré — déjà affiché en titre de section) -->
  <div class="relative flex items-start justify-between">
    <span class="text-sm leading-tight font-medium text-white">{shutter.name}</span>
    <div class="flex items-center gap-1.5">
      {#if isMoving}
        <span class="moving-dots text-[9px] font-medium text-[var(--accent-500)]">●●●</span>
      {/if}
      <span
        class="h-2 w-2 rounded-full"
        style:background-color={shutter.available ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      ></span>
    </div>
  </div>

  <!-- Slider vertical + indicateur valeur -->
  <div class="relative flex items-center gap-4">
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
      <div class="slider-thumb" style:bottom="calc({100 - displayedPosition}% - 18px)">
        <span class="thumb-icon">{thumbIcon}</span>
      </div>
    </div>

    <div class="flex flex-1 items-center">
      {#if displayedPosition <= 1}
        <span class="percent-display text-2xl leading-none font-bold">Ouvert</span>
      {:else if displayedPosition >= 99}
        <span class="percent-display text-2xl leading-none font-bold">Fermé</span>
      {:else}
        <span class="percent-display text-3xl leading-none font-bold">
          {displayedPosition}<span class="text-lg">%</span>
        </span>
      {/if}
    </div>
  </div>

  <!-- Boutons d'action -->
  <div class="relative grid grid-cols-3 gap-1.5">
    <button
      type="button"
      class="action-btn"
      class:active={activeAction === 'open'}
      disabled={!shutter.available}
      onclick={onOpenClick}
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
      class:active={activeAction === 'stop'}
      disabled={!shutter.available}
      onclick={onStopClick}
      aria-label="Arrêter {shutter.name}"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </svg>
    </button>
    <button
      type="button"
      class="action-btn"
      class:active={activeAction === 'close'}
      disabled={!shutter.available}
      onclick={onCloseClick}
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

  /* ─── Indicateur "en mouvement" ─── */
  .moving-dots {
    animation: pulse-dots 1.2s ease-in-out infinite;
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
    touch-action: none;
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

  .slider-fill {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to bottom, var(--accent-600), var(--accent-500));
    box-shadow:
      0 0 16px rgba(61, 253, 152, 0.55),
      0 0 4px rgba(141, 253, 195, 0.4);
    /* Petite transition pour absorber les micro-sauts entre frames RAF
       et les recalibrations sur events serveur. */
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
    transition: bottom 120ms linear;
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
    position: relative;
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
      border-color var(--motion-fast) var(--easing-default),
      color var(--motion-fast) var(--easing-default),
      box-shadow var(--motion-fast) var(--easing-default);
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

  /* ─── État "actif" : glow vert menthe Yeldra pendant l'action ─── */
  .action-btn.active {
    background-color: var(--accent-500);
    border-color: var(--accent-500);
    color: var(--surface-base);
    box-shadow:
      0 0 16px rgba(61, 253, 152, 0.6),
      0 0 32px rgba(61, 253, 152, 0.3),
      inset 0 0 8px rgba(255, 255, 255, 0.2);
    animation: pulse-active 1.2s ease-in-out infinite;
  }

  .action-btn--stop.active {
    background-color: var(--warning);
    border-color: var(--warning);
    color: var(--surface-base);
    box-shadow:
      0 0 16px rgba(255, 184, 77, 0.6),
      0 0 32px rgba(255, 184, 77, 0.3),
      inset 0 0 8px rgba(255, 255, 255, 0.2);
    animation: pulse-active 1.2s ease-in-out infinite;
  }

  @keyframes pulse-active {
    0%,
    100% {
      filter: brightness(1);
    }
    50% {
      filter: brightness(1.15);
    }
  }
</style>
