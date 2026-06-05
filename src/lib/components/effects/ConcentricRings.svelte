<!--
  Anneaux concentriques avec « comète » lumineuse (façon hero Yeldra), recréés
  en CSS pur — aucun asset externe.

  Principe (cf. analyse du SVG Yeldra) : un anneau = un disque dont le fond est un
  conic-gradient (base très faible partout + un arc qui monte en intensité jusqu'à
  une tête quasi blanche = la « lumière »), masqué en anneau fin via un
  radial-gradient. La rotation continue (sens alternés) fait glisser la lumière le
  long du cercle. Chez Yeldra c'était piloté au scroll ; ici rotation continue
  lente, plus vivante et indépendante du défilement.

  Décoratif → aria-hidden. À placer dans un parent positionné (la grille d'anneaux
  se centre sur ce parent). Respecte le réglage Animations + prefers-reduced-motion.
-->
<script lang="ts">
  import { preferences } from '$stores/preferences.svelte';

  interface Props {
    /** Diamètres des anneaux en px (petit → grand). */
    sizes?: number[];
    /** Couleur de la comète en triplet RGB « r, g, b » (défaut : vert OVNI). */
    color?: string;
  }
  let { sizes = [560, 880, 1220], color = '90, 245, 170' }: Props = $props();

  let reducedMotion = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const animated = $derived(preferences.animationsEnabled && !reducedMotion);
</script>

<div class="rings" aria-hidden="true">
  {#each sizes as d, i (d)}
    <span
      class="ring"
      class:ring-anim={animated}
      style="--d: {d}px; --rgb: {color}; --start: {i * 130}deg; --dur: {30 + i * 12}s; --dir: {i % 2
        ? 'reverse'
        : 'normal'};"
    ></span>
  {/each}
</div>

<style>
  .rings {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }
  .ring {
    position: absolute;
    top: 50%;
    left: 50%;
    width: var(--d);
    height: var(--d);
    margin-left: calc(var(--d) / -2);
    margin-top: calc(var(--d) / -2);
    border-radius: 50%;
    /* Base faible partout + comète (longue traîne → tête quasi blanche). */
    background: conic-gradient(
      from var(--start),
      rgba(var(--rgb), 0.07) 0deg,
      rgba(var(--rgb), 0.07) 292deg,
      rgba(var(--rgb), 0.55) 340deg,
      rgba(232, 255, 242, 0.98) 350deg,
      rgba(var(--rgb), 0.07) 354deg,
      rgba(var(--rgb), 0.07) 360deg
    );
    /* Découpe en anneau fin (3 px) + léger halo sur le tracé (la comète brille). */
    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 3px),
      #000 calc(100% - 3px)
    );
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
    filter: drop-shadow(0 0 5px rgba(var(--rgb), 0.55));
  }
  .ring-anim {
    animation: ring-spin var(--dur) linear infinite;
    animation-direction: var(--dir);
  }
  @keyframes ring-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring-anim {
      animation: none;
    }
  }
</style>
