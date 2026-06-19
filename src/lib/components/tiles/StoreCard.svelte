<script lang="ts">
  // ════════════════════════════════════════════════════════════════════════
  //  StoreCard — carte de commande du store-banne (vue tactile iPhone-first).
  //  • une seule ligne : barre de progression draggable à GAUCHE, 3 boutons à DROITE ;
  //  • boutons Rentrer / Stop / Déployer : la banne (SVG réutilisable via snippet)
  //    sert de pictogramme (rentrée / déployée) ; le stop est un carré neutre au
  //    repos et le témoin 3 points jaunes pulsé en manœuvre ;
  //  • barre avec pastille draggable → commande la position (goToPosition) ;
  //    plus de titre « Store » (libellé conservé sur l'aria-label de la carte).
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

<!-- SVG banne réutilisable (pictogramme des boutons Rentrer / Déployer) : toile
     striée à festons. d = path de la toile, h = hauteur (rayures), id = clip unique. -->
{#snippet awningGlyph(
  d: string,
  h: number,
  id: string,
  w: number,
  ht: number,
  par = 'xMidYMid meet'
)}
  <svg width={w} height={ht} viewBox="0 0 60 46" preserveAspectRatio={par} fill="none">
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
  <!-- Barre de progression + pastille draggable (commande la position) — à GAUCHE. -->
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

  <!-- 3 boutons à DROITE : Rentrer / Stop / Déployer (banne = pictogramme rentrée /
       déployée). En manœuvre, le bouton Stop affiche le témoin 3 points jaunes. -->
  <div class="btns">
    <button
      type="button"
      class="abtn abtn--retract"
      class:on={movingDirection === 'open'}
      disabled={!shutter.available}
      onclick={onRetract}
      aria-label="Rentrer le store"
    >
      {@render awningGlyph(PATH_RETRACTED, awningH(0), `s2-ret-${shutter.nodeId}`, 84, 32, 'none')}
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
        <!-- En manœuvre : témoin 3 points jaunes pulsé (remplace la banne animée). -->
        <span class="dots" aria-hidden="true">●●●</span>
      {:else}
        <!-- Au repos : pictogramme « stop » neutre, distinct des bannes voisines.
             viewBox serrée → la taille CSS de .stop-glyph = la taille réelle du carré. -->
        <svg class="stop-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <rect width="16" height="16" rx="3.5" fill="currentColor" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="abtn abtn--deploy"
      class:on={movingDirection === 'close'}
      disabled={!shutter.available}
      onclick={onDeploy}
      aria-label="Déployer le store"
    >
      {@render awningGlyph(PATH_DEPLOYED, awningH(100), `s2-dep-${shutter.nodeId}`, 84, 32, 'none')}
    </button>
  </div>
</div>

<style>
  /* Une seule ligne : barre (flexible) à gauche, boutons (largeur fixe) à droite. */
  .store2 {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  /* Témoin 3 points (dans le bouton Stop, en manœuvre) — repris de l'ancien
     indicateur de titre : même teinte solaire + même pulsation. */
  .dots {
    font-size: 13px;
    letter-spacing: -1px;
    line-height: 1;
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

  /* Boutons : fonds teintés repris des boutons Rentrer/Déployer de la 1ʳᵉ carte. */
  .btns {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    gap: 8px;
  }
  .abtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 54px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: all var(--duration-fast) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .abtn svg {
    width: 42px;
    height: 32px;
  }
  /* Bannes Rentrer/Déployer élargies : remplissent le bouton (étirées
     horizontalement) — robuste quelle que soit la largeur du bouton. */
  .abtn--retract svg,
  .abtn--deploy svg {
    width: 100%;
    max-width: 110px;
  }
  /* Fond indigo (Rentrer) / ambre (Déployer), mais banne TOUJOURS ambre. */
  .abtn--retract {
    flex: 0 0 58px;
    color: var(--color-solar);
    background: var(--color-primary-muted);
    border-color: color-mix(in oklch, var(--color-primary) 30%, transparent);
  }
  .abtn--deploy {
    flex: 0 0 58px;
    color: var(--color-solar);
    background: var(--color-solar-muted);
    border-color: color-mix(in oklch, var(--color-solar) 32%, transparent);
  }
  .abtn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .abtn:disabled {
    opacity: 0.4;
  }
  /* En mouvement : bouton concerné « plein » (comme la 1ʳᵉ carte). */
  .abtn--retract.on {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-fg);
    box-shadow: 0 0 12px var(--color-primary-glow);
  }
  .abtn--deploy.on {
    background: var(--color-solar);
    border-color: var(--color-solar);
    color: var(--color-primary-fg);
    box-shadow: 0 0 12px var(--color-solar-glow);
  }
  /* Bouton stop : carré (≠ Rentrer/Déployer qui s'élargissent), pictogramme
     neutre au repos (≠ bannes ambre), glow ambre en mouvement. */
  .abtn--stop {
    flex: 0 0 54px;
    color: var(--color-muted-fg);
  }
  .abtn--stop.moving {
    color: var(--color-solar);
    border-color: var(--color-solar);
    box-shadow: 0 0 12px var(--color-solar-glow);
  }
  /* Sélecteur assez spécifique pour battre `.abtn svg` (sinon la taille est ignorée). */
  .abtn--stop .stop-glyph {
    width: 13px;
    height: 13px;
  }

  /* Barre + pastille — épaisseur 8px, harmonisée avec les cartes volets (.m-bar). */
  .bar {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 8px;
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
