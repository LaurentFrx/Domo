<script lang="ts">
  /**
   * Aura animée d'arrière-plan d'une carte climat — flocon (froid) / flamme
   * (chaud) qui dit d'un coup d'œil l'état : allumé/éteint (opacité), mode
   * chaud/froid (icône + couleur), en marche (animation : flocon qui tourne /
   * flamme qui vacille). Repris du motif des zones Airzone (`.az-zone-bg`).
   *
   * Se place comme enfant d'une carte `position: relative; overflow: hidden;
   * isolation: isolate` (classe `isolate`) → l'aura (z-index -1) passe DERRIÈRE
   * le contenu sans rien envelopper. Gérer le gate animations + reduced-motion
   * côté appelant (prop `animate`) ; reduced-motion coupé aussi en CSS.
   */
  interface Props {
    heat?: boolean;
    cool?: boolean;
    /** Alimentée → icône bien visible (0.5) ; éteinte → fantôme (0.12). */
    on?: boolean;
    /** En marche (chauffe/refroidit vraiment) → l'icône s'anime. */
    demand?: boolean;
    /** Gate animations (preferences.animationsEnabled). */
    animate?: boolean;
    /** Couleur de l'icône (accent quand on, muet quand off) — résolue par l'appelant. */
    color?: string;
    /** Largeur de l'aura en % de la carte (défaut = taille des cartes Airzone). */
    widthPct?: number;
    /** Position horizontale du centre en % (50 = centré ; <50 décale à gauche). */
    leftPct?: number;
  }
  let {
    heat = false,
    cool = false,
    on = false,
    demand = false,
    animate = false,
    color = 'var(--color-muted-fg)',
    widthPct = 30,
    leftPct = 50
  }: Props = $props();
</script>

{#if heat || cool}
  <svg
    class="aura"
    class:spin={cool && demand && animate}
    class:flame={heat && demand && animate}
    viewBox="0 0 24 24"
    fill={heat ? 'currentColor' : 'none'}
    stroke={heat ? 'none' : 'currentColor'}
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="color: {color}; opacity: {on ? 0.5 : 0.12}; width: {widthPct}%; left: {leftPct}%;"
    aria-hidden="true"
  >
    {#if cool}
      <line x1="2" x2="22" y1="12" y2="12" />
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="m20 16-4-4 4-4" />
      <path d="m4 8 4 4-4 4" />
      <path d="m16 4-4 4-4-4" />
      <path d="m8 20 4-4 4 4" />
    {:else}
      <path
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
      />
    {/if}
  </svg>
{/if}

<style>
  .aura {
    position: absolute;
    top: 50%;
    height: auto;
    transform: translate(-50%, -50%);
    transform-origin: center;
    pointer-events: none;
    z-index: -1; /* derrière le contenu (carte en isolation: isolate) */
    transition:
      color 280ms ease,
      opacity 280ms ease;
  }
  .aura.spin {
    animation: aura-spin 9s linear infinite;
  }
  .aura.flame {
    animation: aura-flame 1.8s ease-in-out infinite;
  }
  @keyframes aura-spin {
    from {
      transform: translate(-50%, -50%) rotate(0deg);
    }
    to {
      transform: translate(-50%, -50%) rotate(360deg);
    }
  }
  @keyframes aura-flame {
    0%,
    100% {
      transform: translate(-50%, -50%) scale(1);
    }
    30% {
      transform: translate(-50%, -53%) scale(1.05);
    }
    65% {
      transform: translate(-50%, -48%) scale(0.97);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .aura {
      transition: none;
    }
    .aura.spin,
    .aura.flame {
      animation: none;
    }
  }
</style>
