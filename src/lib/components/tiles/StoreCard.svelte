<script lang="ts">
  // ════════════════════════════════════════════════════════════════════════
  //  StoreCard — carte de commande du store-banne, version « La terrasse »
  //  (canevas Claude Design « Carte Store — trois directions », 23/08/2026).
  //
  //  • La banne est dessinée en 3D CSS (perspective, plans mur/sol, caisson,
  //    toile inclinée, lambrequin, bras articulés, ombre portée) — pas de WebGL.
  //  • UNE seule valeur anime tout : --store-p (0 = rentré … 1 = déployé),
  //    propriété enregistrée dans app.css et transitionnée ici. La durée suit
  //    la course réelle (shutter.travelMs) ; 0 ms si Animations est désactivé
  //    ou prefers-reduced-motion (l'état reste juste, sans mouvement).
  //  • Deux grands boutons Rentrer / Déployer ; pendant la manœuvre, celui de
  //    la direction en cours devient Stop. La position fine (glissé) a disparu
  //    avec la barre — « après on verra » (Laurent, 23/08/2026).
  //  • Repère : la scène est dessinée à taille fixe (332×210) puis mise à
  //    l'échelle de la carte (--k), pour garder une géométrie 3D calée.
  //  • 23/08/2026 (Laurent) : la banquette d'angle remplace la table et les
  //    tabourets ; plus de soleil ni de fenêtre ; une baie vitrée deux pans
  //    sous le store. Couleurs de la toile et angle de vue INCHANGÉS.
  //  • Plus de ligne de titre : l'état (« Déployé à 59 % ») est inscrit dans
  //    le dessin, en pastille ; boutons à 40 px.
  // ════════════════════════════════════════════════════════════════════════
  import { onDestroy, untrack } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    shutter: Shutter;
  }
  let { shutter }: Props = $props();

  const DEFAULT_TRAVEL_MS = 10_000; // course pleine si travelMs absent (10 %/s)
  const SCENE_W = 332;

  let sceneEl = $state<HTMLDivElement | null>(null);
  let wrapW = $state(SCENE_W);
  const k = $derived(Math.min(1.25, Math.max(0.5, wrapW / SCENE_W)));

  // ── Animation ──
  let target = $state(untrack(() => shutter.position)); // % AFFICHÉ visé par la scène
  let dur = $state(0); // ms de transition vers `target`
  let localMoving = $state(false); // transition locale en cours
  let movingDirection = $state<'open' | 'close' | null>(null);

  let reducedMotion = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const animate = $derived(preferences.animationsEnabled && !reducedMotion);
  const travelMs = $derived(shutter.travelMs ?? DEFAULT_TRAVEL_MS);
  const isMoving = $derived(localMoving || shutter.moving);

  /** Déploiement AFFICHÉ courant (%), lu sur la transition en cours. */
  function currentPct(): number {
    if (!sceneEl) return target;
    const v = parseFloat(getComputedStyle(sceneEl).getPropertyValue('--store-p'));
    return Number.isFinite(v) ? Math.round(v * 100) : target;
  }

  let failsafe: ReturnType<typeof setTimeout> | null = null;
  function clearFailsafe() {
    if (failsafe) clearTimeout(failsafe);
    failsafe = null;
  }
  function freezeHere() {
    const p = currentPct();
    dur = 0;
    target = p;
    localMoving = false;
    clearFailsafe();
  }
  /** Lance la scène vers `pct` à la vitesse réelle (depuis la position en cours). */
  function animateTo(pct: number) {
    const from = currentPct();
    const d = animate ? (Math.abs(pct - from) / 100) * travelMs : 0;
    clearFailsafe();
    dur = 0;
    target = from;
    localMoving = d > 0;
    requestAnimationFrame(() => {
      dur = d;
      target = pct;
    });
    // Si transitionend ne vient pas (onglet en arrière-plan…), on relâche seul.
    failsafe = setTimeout(() => {
      failsafe = null;
      localMoving = false;
      reconcile();
    }, d + 1500);
  }
  function onTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== '--store-p') return;
    localMoving = false;
    clearFailsafe();
    reconcile();
  }

  // Synchro module : à chaque NOUVELLE position rapportée hors manœuvre locale,
  // la scène la rejoint (lissée). Après un Stop, on reste sur l'estimation
  // locale jusqu'à ce que le module confirme sa position (sinon la scène
  // sauterait à l'ancienne valeur puis reviendrait).
  let lastServerPos = untrack(() => shutter.position);
  $effect(() => {
    const pos = shutter.position;
    if (pos === lastServerPos) return;
    lastServerPos = pos;
    if (untrack(() => localMoving)) return;
    dur = untrack(() => animate) ? 600 : 0;
    target = pos;
  });
  /** Fin de transition locale : si le module a rapporté autre chose, on se recale. */
  function reconcile() {
    const pos = shutter.position;
    if (Math.abs(pos - target) > 2) {
      dur = animate ? 600 : 0;
      target = pos;
    }
  }
  $effect(() => {
    if (!isMoving) movingDirection = null;
  });
  onDestroy(clearFailsafe);

  // ── Commandes ──
  function onRetract() {
    matter.open(shutter.nodeId);
    movingDirection = 'open';
    haptic('medium');
    animateTo(0);
  }
  function onDeploy() {
    matter.close(shutter.nodeId);
    movingDirection = 'close';
    haptic('medium');
    animateTo(100);
  }
  function onStop() {
    matter.stop(shutter.nodeId);
    haptic('heavy');
    freezeHere();
    movingDirection = null;
  }

  const stateLabel = $derived.by(() => {
    if (isMoving) return 'En manœuvre…';
    if (target <= 1) return shutter.labelMin ?? 'Rentré';
    if (target >= 99) return shutter.labelMax ?? 'Déployé';
    return `Déployé à ${target} %`;
  });
</script>

<!-- Boîte 3D (3 faces visibles depuis la droite-avant : dessus, face avant, côté droit).
     x,z = coin arrière-gauche ; yTop = hauteur du dessus (y vers le bas) ; w/h/d. -->
{#snippet box(
  x: number,
  yTop: number,
  z: number,
  w: number,
  h: number,
  d: number,
  top: string,
  front: string,
  side: string
)}
  <div
    class="face"
    style="left: {x}px; top: {yTop}px; width: {w}px; height: {d}px; transform: translateZ({z}px) rotateX(90deg); transform-origin: top; background: {top};"
  ></div>
  <div
    class="face"
    style="left: {x}px; top: {yTop}px; width: {w}px; height: {h}px; transform: translateZ({z +
      d}px); background: {front};"
  ></div>
  <div
    class="face"
    style="left: {x +
      w}px; top: {yTop}px; width: {d}px; height: {h}px; transform: translateZ({z}px) rotateY(-90deg); transform-origin: left; background: {side};"
  ></div>
{/snippet}

<div
  class="store3d rounded-[var(--radius-xl)] border"
  class:opacity-50={!shutter.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Store — {stateLabel}"
>
  <!-- Scène 3D : dessinée à 332×210 puis mise à l'échelle de la carte. -->
  <div class="scene-wrap" bind:clientWidth={wrapW} style="--k: {k};">
    <!-- État inscrit dans le dessin (pastille en haut à gauche) -->
    <span class="scene-label">
      {#if isMoving}
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      {/if}
      <span class="tabular-nums">{stateLabel}</span>
    </span>
    <div
      bind:this={sceneEl}
      class="scene"
      style="--store-p: {target / 100}; --dur: {Math.round(dur)}ms;"
      ontransitionend={onTransitionEnd}
      role="img"
      aria-label="Store-banne {stateLabel}"
    >
      <div class="world" aria-hidden="true">
        <div class="wall">
          <!-- Baie vitrée deux pans, sous le store -->
          <div class="bay">
            <div class="pane"></div>
            <div class="pane"></div>
          </div>
        </div>
        <div class="ground">
          <div class="shadow"></div>
          <div class="sofa-shadow"></div>
        </div>
        <!-- Banquette d'angle (retour à DROITE), décalée de ~25 cm du mur (z 20).
             Structure alu blanche sur pieds ; assises : 2 coussins + angle +
             méridienne, dossiers assortis, toile gris clair ; 2 coussins d'appoint
             écru ; tablette teck à lattes au bout. Volumes = dessus/face/côté droit. -->
        {@render box(30, 116, 20, 150, 4, 46, 'var(--rail)', 'var(--rail)', 'var(--frame-dk)')}
        {@render box(134, 116, 66, 46, 4, 60, 'var(--rail)', 'var(--rail)', 'var(--frame-dk)')}
        {@render box(
          32,
          104,
          22,
          48,
          12,
          40,
          'var(--seat-top)',
          'var(--seat-front)',
          'var(--cush-side)'
        )}
        {@render box(
          82,
          104,
          22,
          48,
          12,
          40,
          'var(--seat-top)',
          'var(--seat-front)',
          'var(--cush-side)'
        )}
        {@render box(
          134,
          104,
          22,
          44,
          12,
          44,
          'var(--seat-top)',
          'var(--seat-front)',
          'var(--cush-side)'
        )}
        {@render box(
          134,
          104,
          68,
          44,
          12,
          56,
          'var(--seat-top)',
          'var(--seat-front)',
          'var(--cush-side)'
        )}
        {@render box(
          32,
          82,
          22,
          48,
          22,
          10,
          'var(--cush-top)',
          'var(--back-front)',
          'var(--cush-side)'
        )}
        {@render box(
          82,
          82,
          22,
          48,
          22,
          10,
          'var(--cush-top)',
          'var(--back-front)',
          'var(--cush-side)'
        )}
        {@render box(
          134,
          82,
          22,
          44,
          22,
          10,
          'var(--cush-top)',
          'var(--back-front)',
          'var(--cush-side)'
        )}
        {@render box(
          168,
          82,
          34,
          10,
          22,
          90,
          'var(--cush-top)',
          'var(--cush-side)',
          'var(--back-front)'
        )}
        {@render box(
          44,
          86,
          32,
          20,
          18,
          5,
          'var(--pillow-top)',
          'var(--pillow)',
          'var(--pillow-dk)'
        )}
        {@render box(
          140,
          86,
          32,
          20,
          18,
          5,
          'var(--pillow-top)',
          'var(--pillow)',
          'var(--pillow-dk)'
        )}
        {@render box(134, 116, 126, 46, 4, 16, 'var(--teak)', 'var(--rail)', 'var(--frame-dk)')}
        <div class="leg" style="left: 30px; top: 120px; transform: translateZ(66px);"></div>
        <div class="leg" style="left: 82px; top: 120px; transform: translateZ(66px);"></div>
        <div class="leg" style="left: 134px; top: 120px; transform: translateZ(142px);"></div>
        <div class="leg" style="left: 177px; top: 120px; transform: translateZ(142px);"></div>
        <div class="leg" style="left: 177px; top: 120px; transform: translateZ(66px);"></div>
        <div class="box-top"></div>
        <div class="box-side"></div>
        <div class="box-front"></div>
        <div class="arm l"><div class="seg seg1"><div class="seg seg2"></div></div></div>
        <div class="arm r"><div class="seg seg1"><div class="seg seg2"></div></div></div>
        <div class="fabric"></div>
        <div class="front-bar"></div>
        <div class="valance"></div>
      </div>
    </div>
  </div>

  <!-- Deux grands boutons ; la direction en cours devient Stop. -->
  <div class="btns">
    {#if movingDirection === 'open'}
      <button type="button" class="btn btn--stop" onclick={onStop} aria-label="Arrêter le store">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect width="16" height="16" rx="3.5" fill="currentColor" />
        </svg>
        Stop
      </button>
    {:else}
      <button
        type="button"
        class="btn btn--retract"
        class:dim={isMoving}
        disabled={!shutter.available}
        onclick={onRetract}
        aria-label="Rentrer le store"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg
        >
        Rentrer
      </button>
    {/if}
    {#if movingDirection === 'close'}
      <button type="button" class="btn btn--stop" onclick={onStop} aria-label="Arrêter le store">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect width="16" height="16" rx="3.5" fill="currentColor" />
        </svg>
        Stop
      </button>
    {:else}
      <button
        type="button"
        class="btn btn--deploy"
        class:dim={isMoving}
        disabled={!shutter.available}
        onclick={onDeploy}
        aria-label="Déployer le store"
      >
        Déployer
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg
        >
      </button>
    {/if}
  </div>
</div>

<style>
  .store3d {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    /* Toile : écru rayé bleu charte (hue 262). */
    --toile-a: oklch(0.93 0.025 85);
    --toile-b: oklch(0.47 0.12 262);
    /* Décor clair (jour) ; le sombre redéfinit plus bas. */
    --sky-a: oklch(0.86 0.06 232);
    --sky-b: oklch(0.93 0.03 225);
    --sky-c: oklch(0.95 0.02 200);
    --wall-a: oklch(0.88 0.02 80);
    --wall-b: oklch(0.93 0.02 80);
    --wall-shade: oklch(0.6 0.03 80 / 0.35);
    --wood-a: oklch(0.74 0.05 70);
    --wood-b: oklch(0.69 0.05 70);
    --wood-c: oklch(0.77 0.05 75);
    --wood-line: oklch(0.62 0.05 70);
    --ground-fade: oklch(0.4 0.04 286 / 0.25);
    --shade: oklch(0.25 0.05 286 / 0.42);
    --metal-a: oklch(0.9 0.01 286);
    --metal-b: oklch(0.72 0.015 286);
    --metal-c: oklch(0.8 0.01 286);
    --metal-d: oklch(0.62 0.015 286);
    --frame: oklch(0.96 0.003 80);
    --frame-dk: oklch(0.86 0.004 80);
    --rail: linear-gradient(
      180deg,
      oklch(0.99 0 0),
      oklch(0.92 0.003 80) 45%,
      oklch(0.84 0.004 80)
    );
    --cush: oklch(0.82 0.006 260);
    --cush-side: oklch(0.74 0.007 260);
    /* coussins : galbe (lumière haut-gauche), passepoil clair au bord */
    --seat-top:
      radial-gradient(ellipse 70% 60% at 38% 30%, oklch(1 0 0 / 0.28), transparent 70%),
      linear-gradient(180deg, oklch(1 0 0 / 0.35), transparent 12%), var(--cush);
    --seat-front:
      linear-gradient(180deg, oklch(1 0 0 / 0.22), transparent 40%, oklch(0 0 0 / 0.1)), var(--cush);
    --cush-top: linear-gradient(180deg, oklch(1 0 0 / 0.3), transparent 60%), var(--cush);
    --back-front:
      radial-gradient(ellipse 70% 80% at 45% 35%, oklch(1 0 0 / 0.2), transparent 70%),
      linear-gradient(180deg, transparent 70%, oklch(0 0 0 / 0.1)), var(--cush);
    --pillow: oklch(0.93 0.02 85);
    --pillow-top: oklch(0.97 0.015 85);
    --pillow-dk: oklch(0.86 0.02 85);
    --teak: repeating-linear-gradient(90deg, oklch(0.7 0.09 62) 0 4px, oklch(0.58 0.09 58) 4px 5px);
    --glass-a: oklch(0.72 0.06 240);
    --glass-b: oklch(0.5 0.05 252);
  }
  :global([data-theme='dark']) .store3d {
    --sky-a: oklch(0.3 0.06 262);
    --sky-b: oklch(0.27 0.05 280);
    --sky-c: oklch(0.24 0.045 286);
    /* Mur CRÈME aussi en sombre (Laurent, 23/08/2026) — juste un peu moins éclairé. */
    --wall-a: oklch(0.82 0.035 85);
    --wall-b: oklch(0.87 0.035 85);
    --wall-shade: oklch(0.4 0.04 80 / 0.45);
    --wood-a: oklch(0.5 0.035 70);
    --wood-b: oklch(0.46 0.035 70);
    --wood-c: oklch(0.52 0.035 75);
    --wood-line: oklch(0.47 0.035 70);
    --ground-fade: oklch(0.2 0.03 286 / 0.35);
    --shade: oklch(0.14 0.04 286 / 0.6);
    --metal-a: oklch(0.82 0.02 286);
    --metal-b: oklch(0.58 0.02 286);
    --metal-c: oklch(0.78 0.02 286);
    --metal-d: oklch(0.62 0.02 286);
    --frame: oklch(0.9 0.004 80);
    --frame-dk: oklch(0.78 0.005 80);
    --rail: linear-gradient(
      180deg,
      oklch(0.95 0 0),
      oklch(0.86 0.003 80) 45%,
      oklch(0.76 0.004 80)
    );
    --cush: oklch(0.76 0.007 260);
    --cush-side: oklch(0.66 0.008 260);
    --pillow: oklch(0.88 0.02 85);
    --pillow-top: oklch(0.92 0.015 85);
    --pillow-dk: oklch(0.8 0.02 85);
    --glass-a: oklch(0.5 0.07 262);
    --glass-b: oklch(0.3 0.05 275);
  }

  /* Pastille d'état posée sur le dessin (hors de la scène mise à l'échelle → nette) */
  .scene-label {
    position: absolute;
    left: 10px;
    top: 10px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 10px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    color: oklch(0.98 0.01 286);
    background: oklch(0.22 0.04 286 / 0.55);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    pointer-events: none;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 9999px;
    background: var(--color-solar);
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

  /* ───────────── Scène 3D (CSS, sans WebGL) ───────────── */
  .scene-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 332 / 210;
    overflow: hidden;
    border-radius: 12px;
  }
  .scene {
    position: absolute;
    left: 0;
    top: 0;
    width: 332px;
    height: 210px;
    transform: scale(var(--k));
    transform-origin: top left;
    overflow: hidden;
    border-radius: calc(12px / var(--k));
    perspective: 820px;
    perspective-origin: 56% 18%;
    background:
      radial-gradient(220px 120px at 88% 6%, oklch(0.9 0.12 90 / 0.22), transparent 70%),
      linear-gradient(180deg, var(--sky-a) 0%, var(--sky-b) 55%, var(--sky-c) 100%);
    transition: --store-p var(--dur, 0ms) linear;
  }
  .world {
    position: absolute;
    left: 82px;
    top: 34px;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    transform: rotateX(-12deg) rotateY(-30deg);
  }
  .world :global(*) {
    position: absolute;
    transform-style: preserve-3d;
    box-sizing: border-box;
  }
  /* Mur (plan xy) + fenêtre */
  .wall {
    left: -40px;
    top: -20px;
    width: 300px;
    height: 150px;
    background: linear-gradient(90deg, var(--wall-a), var(--wall-b));
    box-shadow: inset 0 0 40px var(--wall-shade);
  }
  /* Baie vitrée deux pans sous le store (repère mur : x 30…190, y 36…130) */
  .bay {
    left: 70px;
    top: 56px;
    width: 160px;
    height: 94px;
    display: flex;
    gap: 0;
    padding: 3px;
    background: var(--frame);
    box-shadow: inset 0 0 0 1px oklch(0 0 0 / 0.12);
  }
  .pane {
    position: relative;
    flex: 1 1 0;
    margin: 0 1.5px;
    background:
      linear-gradient(115deg, transparent 38%, oklch(1 0 0 / 0.22) 48%, transparent 58%),
      linear-gradient(165deg, var(--glass-a), var(--glass-b) 70%);
    box-shadow: inset 0 0 0 2px var(--frame);
  }
  /* Sol (plan xz), lames de terrasse */
  .ground {
    left: -80px;
    top: 130px;
    width: 380px;
    height: 210px;
    transform-origin: top left;
    transform: rotateX(90deg);
    background: repeating-linear-gradient(
      0deg,
      var(--wood-a) 0 18px,
      var(--wood-line) 18px 19px,
      var(--wood-c) 19px 36px,
      var(--wood-b) 36px 37px
    );
  }
  .ground::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, var(--ground-fade), transparent 45%);
  }
  /* Ombre portée de la toile : profondeur = p × course */
  .shadow {
    left: 66px;
    top: 0;
    width: 224px;
    height: calc(var(--store-p) * 132px);
    background: var(--shade);
    filter: blur(4px);
    transform: skewX(-16deg);
    transform-origin: top left;
  }
  /* Ombre de la banquette sur le deck (repère sol : x +80, y = z) */
  .sofa-shadow {
    left: 104px;
    top: 24px;
    width: 156px;
    height: 120px;
    background: var(--shade);
    filter: blur(4px);
    transform: skewX(-16deg);
    transform-origin: top left;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 66% 100%, 66% 40%, 0 40%);
  }
  .leg {
    width: 3px;
    height: 10px;
    background: var(--frame-dk);
  }
  /* Caisson */
  .box-front {
    left: 0;
    top: 0;
    width: 220px;
    height: 14px;
    border-radius: 3px;
    background: linear-gradient(180deg, var(--metal-a), var(--metal-b));
    transform: translateZ(14px);
  }
  .box-top {
    left: 0;
    top: 0;
    width: 220px;
    height: 14px;
    background: var(--metal-c);
    transform-origin: top;
    transform: rotateX(90deg);
  }
  .box-side {
    left: 0;
    top: 0;
    width: 14px;
    height: 14px;
    background: var(--metal-d);
    transform-origin: left;
    transform: rotateY(-90deg);
  }
  /* Toile : plan incliné de 14°, profondeur = p × 136px, rayures dans le sens de sortie */
  /* ⚠️ Jamais de box-shadow sur un plan 3D : en densité 3 (iPhone) Chromium
     tronque le calque (toile coupée, constaté le 23/08/2026). */
  .fabric {
    left: 0;
    top: 8px;
    width: 220px;
    height: calc(var(--store-p) * 136px);
    transform-origin: top;
    transform-style: flat;
    transform: translateZ(12px) rotateX(76deg);
    background-image:
      linear-gradient(180deg, oklch(1 0 0 / 0.18), transparent 40%, oklch(0 0 0 / 0.12)),
      repeating-linear-gradient(90deg, var(--toile-a) 0 16px, var(--toile-b) 16px 32px);
  }
  /* Lambrequin festonné et barre de front : FRÈRES de la toile (pas enfants),
     posés sur son bord avant par la même --store-p — un enfant qui déborde
     d'un plan preserve-3d fait tronquer le calque parent en densité 3.
     Bord avant : y = 8 + h·cos76°, z = 12 + h·sin76°, h = p × 136 px. */
  .valance {
    left: 0;
    top: calc(8px + var(--store-p) * 32.9px);
    width: 220px;
    height: 16px;
    transform: translateZ(calc(12px + var(--store-p) * 131.96px));
    background-image:
      linear-gradient(180deg, oklch(0 0 0 / 0.08), oklch(0 0 0 / 0.28)),
      repeating-linear-gradient(90deg, var(--toile-a) 0 16px, var(--toile-b) 16px 32px);
    -webkit-mask:
      linear-gradient(#000, #000) 0 0 / 100% 9px no-repeat,
      radial-gradient(circle 7px at 50% 9px, #000 98%, transparent) 0 0 / 14px 100% repeat-x;
    mask:
      linear-gradient(#000, #000) 0 0 / 100% 9px no-repeat,
      radial-gradient(circle 7px at 50% 9px, #000 98%, transparent) 0 0 / 14px 100% repeat-x;
  }
  .front-bar {
    left: 0;
    top: calc(5px + var(--store-p) * 32.9px);
    width: 220px;
    height: 3px;
    background: var(--metal-b);
    transform: translateZ(calc(13px + var(--store-p) * 131.96px));
  }
  /* Bras articulés : deux segments de 68px, coude replié vers le centre, θ = acos(p). */
  .arm {
    top: 19px;
    width: 0;
    height: 0;
    transform: translateZ(12px) rotateX(76deg);
  }
  .arm.l {
    left: 22px;
  }
  .arm.r {
    left: 198px;
  }
  .seg {
    left: -2px;
    top: 0;
    width: 4px;
    height: 68px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--metal-d), var(--metal-a), var(--metal-d));
    transform-origin: top center;
  }
  .arm.l .seg1 {
    transform: rotate(calc(-1 * acos(var(--store-p))));
  }
  .arm.r .seg1 {
    transform: rotate(acos(var(--store-p)));
  }
  .seg2 {
    top: 68px;
  }
  .arm.l .seg2 {
    transform: rotate(calc(2 * acos(var(--store-p))));
  }
  .arm.r .seg2 {
    transform: rotate(calc(-2 * acos(var(--store-p))));
  }

  /* ───────────── Boutons ───────────── */
  .btns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 40px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    font-size: 15px;
    font-weight: 600;
    color: var(--color-fg);
    transition:
      background var(--duration-fast) var(--ease-default),
      opacity var(--duration-fast) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .btn:disabled {
    opacity: 0.4;
  }
  .btn.dim {
    opacity: 0.5;
  }
  .btn--retract {
    background: var(--color-primary-muted);
    border-color: color-mix(in oklch, var(--color-primary) 30%, transparent);
  }
  .btn--deploy {
    color: var(--color-solar);
    background: var(--color-solar-muted);
    border-color: color-mix(in oklch, var(--color-solar) 32%, transparent);
  }
  .btn--stop {
    font-weight: 700;
    color: oklch(0.22 0.05 286);
    background: var(--color-solar);
    border-color: var(--color-solar);
    box-shadow: 0 0 16px var(--color-solar-glow);
  }
</style>
