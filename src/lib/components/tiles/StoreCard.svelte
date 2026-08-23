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
  // ════════════════════════════════════════════════════════════════════════
  import { onDestroy, untrack } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Shutter } from '$stores/matter.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { haptic } from '$utils/haptic';
  import { sunPosition, HOME_LAT, HOME_LON } from '$utils/sun';

  interface Props {
    shutter: Shutter;
    /** Instant de référence pour le soleil (epoch ms) — tests ; défaut : maintenant. */
    now?: number;
  }
  let { shutter, now: nowProp }: Props = $props();

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

  // ── Soleil réel → lumière de la scène ──────────────────────────────────
  // Le mur est orienté au 280° (ouest). Repère monde : x le long du mur vers
  // le nord (droite), y vers le bas, z vers l'extérieur (ouest). Les ombres
  // suivent l'heure : à 14 h 50 le 23/08 elles tombent à droite, vers le mur
  // (photos de référence) ; le matin la maison ombrage toute la terrasse ;
  // la nuit, la scène s'éteint et l'applique s'allume.
  let clock = $state(untrack(() => nowProp ?? Date.now()));
  $effect(() => {
    if (nowProp !== undefined) {
      clock = nowProp;
      return;
    }
    const id = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(id);
  });
  const WALL_AZ = 280; // orientation du mur (°, 0 = nord)
  const light = $derived.by(() => {
    const sun = sunPosition(clock, HOME_LAT, HOME_LON);
    const el = sun.elevationDeg;
    const day = Math.max(0, Math.min(1, (el + 4) / 10)); // 0 = nuit, 1 = plein jour
    const rad = (d: number) => (d * Math.PI) / 180;
    const phi = sun.azimuthDeg + 180; // direction vers laquelle tombent les ombres
    const Lx = Math.cos(rad(el)) * Math.cos(rad(phi - (WALL_AZ - 270)));
    const Lz = Math.cos(rad(el)) * Math.cos(rad(phi - WALL_AZ));
    const Ly = Math.max(0.05, Math.sin(rad(el)));
    const wallLit = el > 0 && Math.cos(rad(sun.azimuthDeg - WALL_AZ)) > 0;
    // Ombre de la toile sur le SOL : rectangle décalé (arrière h=140 px) et cisaillé
    // (la toile descend de 13 px sur sa course de 120 px, pente 6°).
    const sxR = (Lx * 140) / Ly;
    const szR = (Lz * 140) / Ly;
    const dshK = 120 - (13 * Lz) / Ly; // hauteur = p × dshK
    const dshSkew = (Math.atan2((-13 * Lx) / Ly, dshK) * 180) / Math.PI;
    // Ombre de la toile sur le MUR : bande cisaillée sous le coffre (si Lz < 0).
    const wshHk = Lz < -0.01 ? (Ly * 120) / -Lz : 0; // hauteur = min(118, p × wshHk)
    const wshSkew = (Math.atan2(Lx, Ly) * 180) / Math.PI;
    // Ombre de la MAISON sur le sol quand le soleil est derrière elle.
    const hshD = !wallLit && el > 0 ? Math.min(240, (290 * Math.max(0, Lz)) / Ly) : 0;
    return {
      day,
      wallLit,
      sunUp: el > 0,
      dshLeft: 44 + sxR,
      dshTop: szR,
      dshK,
      dshSkew,
      dshOn: wallLit ? 1 : 0,
      wshHk,
      wshSkew,
      hshD
    };
  });
  const lightStyle = $derived(
    `--day: ${light.day.toFixed(3)}; --night: ${(1 - light.day).toFixed(3)};` +
      ` --wall-dim: ${light.sunUp && !light.wallLit ? 0.32 : 0};` +
      ` --dsh-left: ${light.dshLeft.toFixed(1)}px; --dsh-top: ${light.dshTop.toFixed(1)}px;` +
      ` --dsh-k: ${light.dshK.toFixed(1)}px; --dsh-skew: ${light.dshSkew.toFixed(1)}deg; --dsh-on: ${light.dshOn};` +
      ` --wsh-hk: ${light.wshHk.toFixed(1)}px; --wsh-skew: ${light.wshSkew.toFixed(1)}deg;` +
      ` --hsh-d: ${light.hshD.toFixed(1)}px;`
  );

  const stateLabel = $derived.by(() => {
    if (isMoving) return 'En manœuvre…';
    if (target <= 1) return shutter.labelMin ?? 'Rentré';
    if (target >= 99) return shutter.labelMax ?? 'Déployé';
    return `Déployé à ${target} %`;
  });
</script>

<!-- Boîte 3D (3 faces visibles depuis le sud-ouest : dessus, face avant, côté gauche).
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
    style="left: {x}px; top: {yTop}px; width: {d}px; height: {h}px; transform: translateZ({z}px) rotateY(-90deg); transform-origin: left; background: {side};"
  ></div>
{/snippet}

<div
  class="store3d rounded-[var(--radius-xl)] border"
  class:opacity-50={!shutter.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Store — {stateLabel}"
>
  <div class="head">
    <span class="name">Store</span>
    <span class="status">
      {#if isMoving}
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      {/if}
      <span class="tabular-nums">{stateLabel}</span>
    </span>
  </div>

  <!-- Scène 3D : la terrasse réelle (mur ouest au 280°), dessinée à 332×210
       puis mise à l'échelle de la carte. Repère : 1 px = 2,5 cm. -->
  <div class="scene-wrap" bind:clientWidth={wrapW} style="--k: {k};">
    <div
      bind:this={sceneEl}
      class="scene"
      style="--store-p: {target / 100}; --dur: {Math.round(dur)}ms; {lightStyle}"
      ontransitionend={onTransitionEnd}
      role="img"
      aria-label="Store-banne {stateLabel}"
    >
      <div class="sky-night" aria-hidden="true"></div>
      <div class="world" aria-hidden="true">
        <!-- Mur crépi (plan xy), ombre de la maison, porte à volet, applique -->
        <div class="wall">
          <div class="wall-dim"></div>
          <div class="wall-shadow"></div>
          <div class="door">
            <div class="shutter"></div>
            <div class="glass"></div>
          </div>
          <div class="lamp"><i class="lamp-glow"></i></div>
          <div class="roof-edge"></div>
        </div>
        <!-- Abri à poutres bois au coin droit -->
        <div class="abri-back"></div>
        <div class="abri-roof"></div>
        <div class="abri-post"></div>
        <!-- Deck en lames grises (plan xz) + ombres portées -->
        <div class="ground">
          <div class="house-shadow"></div>
          <div class="deck-shadow"></div>
        </div>
        <!-- Mobilier (boîtes : dessus, face, côté gauche) -->
        {@render box(
          -52,
          172,
          8,
          44,
          3,
          36,
          'var(--ftab-top)',
          'var(--ftab-top)',
          'var(--ftab-top)'
        )}
        <div class="leg" style="left: -48px; top: 175px; transform: translateZ(40px);"></div>
        <div class="leg" style="left: -14px; top: 175px; transform: translateZ(12px);"></div>
        {@render box(116, 186, 6, 116, 14, 36, 'var(--cush)', 'var(--frame)', 'var(--frame)')}
        {@render box(
          116,
          158,
          6,
          116,
          28,
          9,
          'var(--cush-side)',
          'var(--cush)',
          'var(--cush-side)'
        )}
        {@render box(116, 186, 42, 36, 14, 54, 'var(--cush)', 'var(--frame)', 'var(--frame)')}
        {@render box(
          116,
          158,
          42,
          7,
          28,
          54,
          'var(--cush-side)',
          'var(--cush-side)',
          'var(--cush)'
        )}
        {@render box(158, 188, 54, 46, 12, 44, 'var(--teak)', 'var(--frame)', 'var(--frame)')}
        {@render box(268, 184, 62, 16, 16, 16, 'var(--pot-top)', 'var(--pot)', 'var(--pot-dark)')}
        <!-- Olivier (panneau face caméra) -->
        <div class="olive">
          <i class="trunk"></i>
          <i class="leaves l1"></i>
          <i class="leaves l2"></i>
          <i class="leaves l3"></i>
          <i class="leaves l4"></i>
          <i class="leaves l5"></i>
        </div>
        <!-- Store-banne : coffre, bras, toile (dessus + dessous), barre de front -->
        <div class="box-front"></div>
        <div class="box-top"></div>
        <div class="box-bottom"></div>
        <div class="box-side"></div>
        <div class="arm l"><div class="seg seg1"><div class="seg seg2"></div></div></div>
        <div class="arm r"><div class="seg seg1"><div class="seg seg2"></div></div></div>
        <div class="fabric fabric-top"></div>
        <div class="fabric fabric-under"></div>
        <div class="fabric fabric-bar"><div class="front-bar"></div></div>
      </div>
      <div class="night-veil" aria-hidden="true"></div>
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
    /* Palette de la terrasse réelle (photos du 23/08/2026). */
    --wall-a: oklch(0.9 0.035 85);
    --wall-b: oklch(0.86 0.04 85);
    --streak: oklch(0.78 0.035 85 / 0.35);
    --anthracite: oklch(0.33 0.012 250);
    --toile-top: oklch(0.79 0.03 78);
    --toile-under: oklch(0.66 0.028 76);
    --deck-a: oklch(0.8 0.012 85);
    --deck-b: oklch(0.76 0.012 80);
    --deck-gap: oklch(0.66 0.012 85);
    --frame: oklch(0.95 0.003 80);
    --cush: oklch(0.9 0.018 85);
    --cush-side: oklch(0.84 0.02 85);
    --teak: repeating-linear-gradient(90deg, oklch(0.7 0.09 62) 0 5px, oklch(0.6 0.09 58) 5px 6px);
    --ftab-top: oklch(0.7 0.02 80);
    --pot: oklch(0.55 0.2 28);
    --pot-top: oklch(0.62 0.2 30);
    --pot-dark: oklch(0.45 0.18 27);
    --olive-a: oklch(0.62 0.05 125);
    --olive-b: oklch(0.5 0.045 122);
    --olive-c: oklch(0.72 0.045 120);
    --trunk: oklch(0.45 0.04 70);
    --abri-wood: oklch(0.46 0.06 55);
    --abri-back: oklch(0.34 0.03 60);
    /* Ombres OPAQUES (couleur de la surface déjà assombrie) : un calque
       translucide posé sur un plan 3D est perdu au tri des calques. */
    --shade-wall: oklch(0.64 0.04 85);
    --shade-deck: oklch(0.56 0.015 85);
    --sky-a: oklch(0.74 0.1 240);
    --sky-b: oklch(0.92 0.04 225);
    --shutter: oklch(0.95 0.004 80);
    --glass: oklch(0.32 0.03 250);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .name {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.15;
    color: var(--color-fg);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-muted-fg);
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
    /* Caméra (≈ 67° de champ) : l'œil est au centre du cadre, à 250 px du plan. */
    --yaw: 49deg;
    perspective: 250px;
    perspective-origin: 50% 50%;
    background: linear-gradient(180deg, var(--sky-a) 0%, var(--sky-b) 70%);
    transition: --store-p var(--dur, 0ms) linear;
  }
  .sky-night {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, oklch(0.2 0.05 272), oklch(0.3 0.05 280));
    opacity: var(--night, 0);
  }
  .night-veil {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: oklch(0.2 0.05 275);
    opacity: calc(var(--night, 0) * 0.55);
    mix-blend-mode: multiply;
  }
  /* Vue = Rx(tangage) · Ry(lacet) · T(−caméra). Caméra au coin sud-ouest du deck :
     x −90 (2,25 m à gauche du mur visible), 1,75 m de haut (y 130), z 230 (5,75 m
     devant le mur), lacet 50° vers le salon — l'angle des photos de référence. */
  .world {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    transform-origin: 0 0 0;
    transform: rotateX(8deg) rotateY(var(--yaw)) translate3d(70px, -156px, -150px);
  }
  .world :global(*) {
    position: absolute;
    transform-style: preserve-3d;
    box-sizing: border-box;
  }
  /* Mur crépi (plan xy) : x −60…300, y −90…200 (deck) */
  .wall {
    left: -400px;
    top: -90px;
    width: 700px;
    height: 290px;
    background:
      repeating-linear-gradient(
        90deg,
        transparent 0 23px,
        var(--streak) 23px 26px,
        transparent 26px 41px
      ),
      linear-gradient(90deg, var(--wall-a), var(--wall-b));
  }
  .wall-dim {
    inset: 0;
    background: oklch(0.3 0.03 80);
    opacity: var(--wall-dim, 0);
    transform: translateZ(0.4px);
  }
  /* Ombre de la toile sur le mur : sous le coffre (x 44…204, y 82), cisaillée vers la droite */
  .wall-shadow {
    left: 444px;
    top: 154px;
    width: 160px;
    height: min(136px, calc(var(--store-p) * var(--wsh-hk, 0px)));
    background: var(--shade-wall);
    transform: translateZ(0.6px) skewX(var(--wsh-skew, 0deg));
    transform-origin: top left;
  }
  .door {
    left: 458px;
    top: 194px;
    width: 48px;
    height: 96px;
    border: 2px solid var(--frame);
    background: var(--glass);
  }
  .shutter {
    left: 0;
    top: 0;
    width: 100%;
    height: 56%;
    background: repeating-linear-gradient(
      180deg,
      var(--shutter) 0 3px,
      oklch(0.82 0.006 80) 3px 4px
    );
  }
  .glass {
    left: 0;
    top: 56%;
    width: 100%;
    height: 44%;
    background: linear-gradient(160deg, oklch(0.45 0.04 245), var(--glass) 60%);
  }
  .lamp {
    left: 436px;
    top: 190px;
    width: 6px;
    height: 16px;
    border-radius: 1px;
    background: var(--anthracite);
  }
  .lamp-glow {
    left: -22px;
    top: -14px;
    width: 50px;
    height: 44px;
    border-radius: 9999px;
    background: radial-gradient(circle, oklch(0.9 0.12 85 / 0.75), transparent 70%);
    opacity: var(--night, 0);
  }
  /* Rive du toit (pignon) : bande sombre qui monte vers la gauche depuis le coin */
  .roof-edge {
    right: -4px;
    top: 34px;
    width: 230px;
    height: 9px;
    transform-origin: right center;
    transform: rotate(-32deg);
    background: linear-gradient(180deg, oklch(0.5 0.03 70), oklch(0.36 0.03 70));
  }
  /* Abri bois au coin droit : fond sombre, toit à poutres, poteau */
  .abri-back {
    left: 300px;
    top: 96px;
    width: 90px;
    height: 104px;
    background: var(--abri-back);
  }
  .abri-roof {
    left: 300px;
    top: 96px;
    width: 90px;
    height: 64px;
    transform-origin: top;
    transform: rotateX(82deg);
    background: repeating-linear-gradient(
      90deg,
      var(--abri-wood) 0 6px,
      oklch(0.38 0.05 55) 6px 8px,
      oklch(0.5 0.06 58) 8px 12px
    );
  }
  .abri-post {
    left: 386px;
    top: 106px;
    width: 5px;
    height: 94px;
    background: var(--abri-wood);
    transform: translateZ(60px);
  }
  /* Deck en lames parallèles au mur (plan xz) : x −100…420, z 0…240 */
  .ground {
    left: -300px;
    top: 200px;
    width: 760px;
    height: 420px;
    transform-origin: top left;
    transform: rotateX(90deg);
    overflow: hidden;
    background: repeating-linear-gradient(
      0deg,
      var(--deck-a) 0 6px,
      var(--deck-gap) 6px 7px,
      var(--deck-b) 7px 13px,
      var(--deck-gap) 13px 14px
    );
  }
  .house-shadow {
    left: 0;
    top: 0;
    width: 100%;
    height: var(--hsh-d, 0px);
    background: var(--shade-deck);
    transform: translateZ(0.4px);
  }
  /* Ombre de la toile sur le deck : décalée par le soleil, cisaillée, hauteur = p × k */
  .deck-shadow {
    left: calc(300px + var(--dsh-left, 44px));
    top: var(--dsh-top, 0px);
    width: 160px;
    height: calc(var(--store-p) * var(--dsh-k, 120px));
    background: var(--shade-deck);
    opacity: var(--dsh-on, 1);
    transform: translateZ(0.6px) skewX(var(--dsh-skew, 0deg));
    transform-origin: top left;
  }
  .leg {
    width: 2px;
    height: 25px;
    background: oklch(0.55 0.02 80);
  }
  /* Olivier : panneau face caméra (contre-rotation du monde), feuillage en dégradés */
  .olive {
    left: 245px;
    top: 0;
    width: 180px;
    height: 200px;
    transform-origin: 50% 100%;
    transform: translateZ(130px) rotateY(calc(-1 * var(--yaw)));
  }
  .olive .trunk {
    left: 86px;
    top: 120px;
    width: 9px;
    height: 80px;
    border-radius: 3px;
    background: var(--trunk);
  }
  .olive .leaves {
    border-radius: 9999px;
    background: radial-gradient(
      circle at 40% 35%,
      var(--olive-c),
      var(--olive-a) 45%,
      var(--olive-b) 80%,
      transparent 100%
    );
  }
  .olive .l1 {
    left: 20px;
    top: 0;
    width: 150px;
    height: 130px;
  }
  .olive .l2 {
    left: 0;
    top: 50px;
    width: 110px;
    height: 95px;
    opacity: 0.95;
  }
  .olive .l3 {
    left: 80px;
    top: 60px;
    width: 100px;
    height: 85px;
    opacity: 0.9;
  }
  .olive .l4 {
    left: 60px;
    top: -10px;
    width: 90px;
    height: 70px;
    opacity: 0.85;
  }
  .olive .l5 {
    left: 110px;
    top: 30px;
    width: 80px;
    height: 70px;
    opacity: 0.9;
  }
  /* Coffre anthracite : x 44…204, y 74…82, profondeur 8 */
  .box-front {
    left: 44px;
    top: 56px;
    width: 160px;
    height: 8px;
    background: linear-gradient(180deg, oklch(0.42 0.012 250), var(--anthracite));
    transform: translateZ(8px);
  }
  .box-top {
    left: 44px;
    top: 56px;
    width: 160px;
    height: 8px;
    background: oklch(0.4 0.012 250);
    transform-origin: top;
    transform: rotateX(90deg);
  }
  .box-bottom {
    left: 44px;
    top: 64px;
    width: 160px;
    height: 8px;
    background: oklch(0.26 0.012 250);
    transform-origin: top;
    transform: rotateX(90deg);
  }
  .box-side {
    left: 44px;
    top: 56px;
    width: 8px;
    height: 8px;
    background: oklch(0.3 0.012 250);
    transform-origin: left;
    transform: rotateY(-90deg);
  }
  /* Toile greige unie : plan incliné de 15°, profondeur = p × 120 px (3 m) */
  .fabric {
    left: 44px;
    top: 60px;
    width: 160px;
    height: calc(var(--store-p) * 120px);
    transform-origin: 50% 0;
    backface-visibility: hidden;
  }
  .fabric-top {
    transform: translateZ(8px) rotateX(84deg);
    background: linear-gradient(180deg, oklch(1 0 0 / 0.1), transparent 40%), var(--toile-top);
  }
  .fabric-under {
    transform: translateZ(7.5px) rotateX(84deg) rotateY(180deg);
    background: linear-gradient(180deg, oklch(0 0 0 / 0.12), transparent 50%), var(--toile-under);
  }
  .fabric-bar {
    transform: translateZ(8px) rotateX(84deg);
    backface-visibility: visible;
  }
  .front-bar {
    left: 0;
    top: calc(100% - 3px);
    width: 160px;
    height: 4px;
    background: var(--anthracite);
    transform-origin: top;
    transform: rotateX(-84deg);
  }
  /* Bras articulés anthracite : deux segments de 60 px, θ = acos(p) */
  .arm {
    top: 68px;
    width: 0;
    height: 0;
    transform: translateZ(8px) rotateX(84deg);
  }
  .arm.l {
    left: 58px;
  }
  .arm.r {
    left: 190px;
  }
  .seg {
    left: -1.5px;
    top: 0;
    width: 3px;
    height: 60px;
    border-radius: 1.5px;
    background: var(--anthracite);
    transform-origin: top center;
  }
  .arm.l .seg1 {
    transform: rotate(calc(-1 * acos(var(--store-p))));
  }
  .arm.r .seg1 {
    transform: rotate(acos(var(--store-p)));
  }
  .seg2 {
    top: 60px;
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
    height: 48px;
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
