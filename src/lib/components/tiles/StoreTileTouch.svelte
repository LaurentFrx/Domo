<script lang="ts">
  // ════════════════════════════════════════════════════════════════════════
  //  StoreTileTouch — variante TACTILE de la carte store (prototype comparatif)
  //  Isolé du ShutterTile en service (cf. règle « ne pas casser les cartes »).
  //  • en-tête épuré (icône banne + « Store »), pas d'indication d'état ;
  //  • 3 boutons dont l'icône EST une banne : rentrée / position réelle (stop) /
  //    déployée — le SVG banne (réutilisé partout via un snippet) reflète l'état
  //    courant et s'anime naturellement quand le store bouge ;
  //  • barre de progression avec pastille draggable → commande la position.
  // ════════════════════════════════════════════════════════════════════════
  import { onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    shutter: Shutter;
  }
  let { shutter }: Props = $props();

  // shutter.position = % de déploiement AFFICHÉ (0 = rentré, 100 = déployé)
  let dragging = $state(false);
  let dragPos = $state(0);
  let barEl = $state<HTMLDivElement | null>(null);

  const THUMB = 24; // px — diamètre pastille (sert aussi au calcul de drag)
  const DEFAULT_SPEED = 10; // %/s si pas de travelMs
  let animPos = $state<number | null>(null);
  let animTarget = 0;
  let lastFrame = 0;
  let rafId: number | null = null;
  let lastServerPos: number | null = null;
  let movingDirection = $state<'open' | 'close' | null>(null);

  const displayedPosition = $derived(
    dragging ? dragPos : animPos !== null ? Math.round(animPos) : shutter.position
  );
  const positionLabel = $derived(
    displayedPosition <= 1
      ? (shutter.labelMin ?? 'Rentré')
      : displayedPosition >= 99
        ? (shutter.labelMax ?? 'Déployé')
        : `${displayedPosition}%`
  );
  const isMoving = $derived(animPos !== null || shutter.moving);

  // ─── SVG banne (vue de face) : toile à lambrequin festonné ───
  const SCALLOP = ' q -3.25 6.4 -6.5 0'.repeat(6);
  const awningH = (pos: number) => 3 + (pos / 100) * 27;
  const awningPath = (pos: number) =>
    `M12 11.5 L48 11.5 L49.5 ${11.5 + awningH(pos)}${SCALLOP} L12 11.5 Z`;
  const PATH_RETRACTED = awningPath(0);
  const PATH_DEPLOYED = awningPath(100);
  const headPath = $derived(awningPath(displayedPosition));
  const headH = $derived(awningH(displayedPosition));

  // ─── Animation visuelle de la position (rAF), calée sur travelMs ───
  function cancelRaf() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  function setVisualTarget(target: number) {
    cancelRaf();
    const from = dragging ? dragPos : (animPos ?? shutter.position);
    if (Math.abs(from - target) < 0.5) {
      animPos = null;
      return;
    }
    animPos = from;
    animTarget = target;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function tick(t: number) {
    rafId = null;
    if (animPos === null) return;
    const dt = (t - lastFrame) / 1000;
    lastFrame = t;
    const dir = animTarget > animPos ? 1 : -1;
    const speed = shutter.travelMs ? 100_000 / shutter.travelMs : DEFAULT_SPEED;
    const next = animPos + dir * speed * dt;
    if ((dir > 0 && next >= animTarget) || (dir < 0 && next <= animTarget)) {
      animPos = animTarget;
      scheduleFailsafe();
      return;
    }
    animPos = next;
    rafId = requestAnimationFrame(tick);
  }
  let failsafe: ReturnType<typeof setTimeout> | null = null;
  function scheduleFailsafe() {
    if (failsafe) clearTimeout(failsafe);
    failsafe = setTimeout(() => {
      failsafe = null;
      if (rafId === null && animPos === animTarget) animPos = null;
    }, 20000);
  }
  function stopAnim() {
    cancelRaf();
    if (failsafe) {
      clearTimeout(failsafe);
      failsafe = null;
    }
    animPos = null;
    movingDirection = null;
  }

  // Synchro serveur : recale l'anim si l'écart est grand, coupe si arrivé.
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
      stopAnim();
      return;
    }
    if (Math.abs(pos - animPos) > 10) {
      animPos = pos;
      lastFrame = performance.now();
      if (rafId === null && pos !== animTarget) rafId = requestAnimationFrame(tick);
    }
  });
  $effect(() => {
    if (!isMoving) movingDirection = null;
  });
  onDestroy(() => {
    stopAnim();
  });

  // ─── Drag horizontal de la pastille ───
  const clamp = (p: number) => Math.max(0, Math.min(100, p));
  function posFromX(clientX: number): number {
    if (!barEl) return shutter.position;
    const r = barEl.getBoundingClientRect();
    const usable = Math.max(1, r.width - THUMB); // garde anti-NaN si barre non mesurée
    const x = clientX - r.left - THUMB / 2;
    return clamp(Math.round((x / usable) * 100));
  }
  function onDown(e: PointerEvent) {
    if (!shutter.available) return;
    cancelRaf();
    if (failsafe) {
      clearTimeout(failsafe);
      failsafe = null;
    }
    animPos = null;
    dragging = true;
    dragPos = posFromX(e.clientX);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    e.preventDefault();
    dragPos = posFromX(e.clientX);
  }
  function onUp(e: PointerEvent) {
    if (!dragging) return;
    const final = posFromX(e.clientX);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragging = false;
    // Relâché sur la position courante (simple tap, aucun déplacement) → pas de
    // commande moteur ni de glow directionnel.
    if (final === shutter.position) return;
    matter.goToPosition(shutter.nodeId, final);
    movingDirection = final < shutter.position ? 'open' : 'close';
    haptic('light');
    animPos = final;
    animTarget = final;
    scheduleFailsafe();
  }

  function onRetract() {
    matter.open(shutter.nodeId);
    movingDirection = 'open';
    haptic('medium');
    setVisualTarget(0);
  }
  function onDeploy() {
    matter.close(shutter.nodeId);
    movingDirection = 'close';
    haptic('medium');
    setVisualTarget(100);
  }
  function onStop() {
    matter.stop(shutter.nodeId);
    movingDirection = null;
    haptic('heavy');
    cancelRaf();
    if (animPos !== null) {
      animTarget = animPos;
      scheduleFailsafe();
    }
  }
</script>

<!-- SVG banne réutilisable (le MÊME que la 1ʳᵉ carte) : toile striée à festons.
     d = path de la toile, h = hauteur de toile (rayures), id = clip unique. -->
{#snippet awningGlyph(d: string, h: number, id: string, w: number, ht: number)}
  <svg width={w} height={ht} viewBox="0 0 60 46" fill="none">
    <clipPath {id}><path {d} /></clipPath>
    <path {d} fill="currentColor" />
    <g clip-path="url(#{id})">
      {#each [10.5, 23.5, 36.5] as sx}
        <rect x={sx} y="11.5" width="6.5" height={h + 8} fill="#fff" opacity="0.4" />
      {/each}
    </g>
    <rect
      x="8"
      y="6"
      width="44"
      height="5.6"
      rx="2.6"
      style="fill: var(--color-muted-fg);"
      opacity="0.9"
    />
    <rect x="9" y="6.5" width="42" height="1.4" rx="0.7" fill="#fff" opacity="0.22" />
  </svg>
{/snippet}

<div
  class="store2 rounded-[var(--radius-xl)] border"
  class:opacity-50={!shutter.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Store — {positionLabel}"
>
  <!-- En-tête épuré : icône banne (état réel) + « Store » -->
  <div class="head">
    <span class="awning" aria-hidden="true">
      {@render awningGlyph(headPath, headH, `s2-head-${shutter.nodeId}`, 56, 43)}
    </span>
    <span class="title">Store</span>
    {#if isMoving}<span class="dots" aria-hidden="true">●●●</span>{/if}
  </div>

  <!-- Boutons : la banne EST le pictogramme — rentrée / position réelle (stop) /
       déployée. Le bouton stop réutilise le SVG de l'état courant (= en-tête). -->
  <div class="btns">
    <button
      type="button"
      class="abtn"
      class:on={movingDirection === 'open'}
      disabled={!shutter.available}
      onclick={onRetract}
      aria-label="Rentrer le store"
    >
      {@render awningGlyph(PATH_RETRACTED, awningH(0), `s2-ret-${shutter.nodeId}`, 42, 32)}
    </button>
    <button
      type="button"
      class="abtn abtn--stop"
      class:moving={isMoving}
      disabled={!shutter.available}
      onclick={onStop}
      aria-label="Arrêter le store"
    >
      {#if isMoving}
        <!-- En mouvement : banne live (= 1ʳᵉ carte), s'anime avec le déplacement réel. -->
        {@render awningGlyph(headPath, headH, `s2-stop-${shutter.nodeId}`, 42, 32)}
      {:else}
        <!-- Au repos : pictogramme « stop » neutre, distinct des bannes voisines. -->
        <svg class="stop-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="abtn"
      class:on={movingDirection === 'close'}
      disabled={!shutter.available}
      onclick={onDeploy}
      aria-label="Déployer le store"
    >
      {@render awningGlyph(PATH_DEPLOYED, awningH(100), `s2-dep-${shutter.nodeId}`, 42, 32)}
    </button>
  </div>

  <!-- Barre de progression + pastille draggable (commande la position) -->
  <div
    bind:this={barEl}
    class="bar"
    class:dragging
    role="slider"
    tabindex={shutter.available ? 0 : -1}
    aria-label="Position du store"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={displayedPosition}
    aria-valuetext={positionLabel}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
  >
    <div
      class="fill"
      style:width="calc({THUMB / 2}px + (100% - {THUMB}px) * {displayedPosition / 100})"
    ></div>
    <div class="thumb" style:left="calc((100% - {THUMB}px) * {displayedPosition / 100})">
      {#if displayedPosition > 1 && displayedPosition < 99}
        <span class="thumb-pct">{displayedPosition}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .store2 {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .awning {
    display: inline-flex;
    color: var(--color-solar);
    flex-shrink: 0;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .dots {
    margin-left: auto;
    font-size: 9px;
    letter-spacing: -2px;
    color: var(--color-solar);
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

  /* Boutons : icône banne ambre sur fond verre neutre */
  .btns {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }
  .abtn {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    height: 54px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    color: var(--color-solar);
    transition: all var(--duration-fast) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .abtn svg {
    width: 42px;
    height: 32px;
  }
  .abtn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .abtn:disabled {
    opacity: 0.4;
  }
  .abtn.on {
    border-color: var(--color-solar);
    box-shadow: 0 0 12px var(--color-solar-glow);
  }
  /* Bouton stop : pictogramme neutre au repos (≠ bannes ambre), glow ambre en mouvement. */
  .abtn--stop {
    color: var(--color-muted-fg);
  }
  .abtn--stop.moving {
    color: var(--color-solar);
    border-color: var(--color-solar);
    box-shadow: 0 0 12px var(--color-solar-glow);
  }
  .stop-glyph {
    width: 22px;
    height: 22px;
  }

  /* Barre + pastille */
  .bar {
    position: relative;
    height: 14px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    touch-action: pan-y;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    cursor: pointer;
  }
  .bar:focus-visible {
    outline: 2px solid var(--color-solar);
    outline-offset: 2px;
  }
  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    border-radius: 9999px;
    background: linear-gradient(to right, var(--color-solar), oklch(0.78 0.16 75));
    transition: width 120ms linear;
    pointer-events: none;
  }
  .bar.dragging .fill {
    transition: none;
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 24px;
    height: 24px;
    transform: translateY(-50%);
    border-radius: 50%;
    background: oklch(0.99 0.005 286);
    box-shadow:
      0 2px 6px oklch(0.1 0.01 286 / 0.22),
      0 1px 2px oklch(0.1 0.01 286 / 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    color: oklch(0.3 0.01 280);
    transition: left 120ms linear;
    pointer-events: none;
  }
  .bar.dragging .thumb {
    transition: none;
  }
  .thumb-pct {
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1;
  }
</style>
