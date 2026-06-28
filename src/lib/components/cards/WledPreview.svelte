<script lang="ts">
  /**
   * Aperçu visuel de l'éclairage WLED « tel qu'il est réglé ».
   * Une barre de lumière par segment, rendue façon COB RGBW : trait CONTINU et
   * diffus (pas de points) avec halo (bloom). Reflète en direct la couleur
   * effective (RGB + blanc 4000K), la luminosité (maître × segment), l'effet
   * (couleur fixe / dégradé de palette animé / pulsation) et l'état on/off.
   *
   * Animations gardées par `animated` (préférence app) + @media reduced-motion :
   * désactivées → image fixe représentative (couleur/luminosité conservées).
   */
  import { wled, effectiveColor, type RGB } from '$stores/wled.svelte';

  interface Props {
    /** Animer les effets dynamiques (sinon image fixe). */
    animated?: boolean;
  }
  let { animated = true }: Props = $props();

  // Palettes « couleur » (= utilisent la couleur du segment, pas un dégradé).
  const COLOR_PALETTES = new Set([
    'Default',
    'Random Cycle',
    'Color 1',
    'Colors 1&2',
    'Color Gradient',
    'Colors Only'
  ]);

  const RAINBOW = ['#ff0040', '#ff8000', '#ffff00', '#00ff40', '#00ffff', '#0040ff', '#8000ff'];

  // Effets « arc-en-ciel / palette » : s'ils tournent sans dégradé de palette
  // dédié, on les rend en spectre animé.
  const RAINBOW_FX = new Set([
    'Rainbow',
    'Rainbow Runner',
    'Colorful',
    'Colorloop',
    'Colorwaves',
    'Pride 2015',
    'Aurora',
    'Palette',
    'Blends',
    'Plasma',
    'Flow',
    'Dynamic',
    'Dynamic Smooth',
    'Noise Pal',
    'Colortwinkles'
  ]);

  // Dégradés représentatifs des palettes WLED courantes (fallback = couleur effective).
  const PALETTE_GRADIENTS: Record<string, string[]> = {
    Party: ['#ff00b0', '#ff0040', '#ffb000', '#ffe000', '#00d0ff', '#7000ff'],
    Rainbow: RAINBOW,
    'Rainbow Bands': RAINBOW,
    Sunset: ['#2b1a4a', '#7a2e6b', '#e0533f', '#ff9e4f', '#ffd66b'],
    'Sunset 2': ['#3a1d6e', '#c0395f', '#ff6a3c', '#ffb24f', '#ffe08a'],
    Ocean: ['#012a4a', '#0353a4', '#2c7da0', '#61a5c2', '#a9d6e5'],
    Atlantica: ['#003049', '#0077b6', '#00b4d8', '#90e0ef'],
    Forest: ['#0b3d0b', '#1e6b1e', '#3fa34d', '#9bd17a', '#d8f3a0'],
    Lava: ['#000000', '#5a0000', '#b30000', '#ff6a00', '#ffd000'],
    Fire: ['#000000', '#7a0000', '#ff3000', '#ff9a00', '#ffe000'],
    Cloud: ['#0a1a4a', '#2a52be', '#6fa8dc', '#bcd6f2', '#ffffff'],
    Pastel: ['#ffd1dc', '#ffe7c2', '#fff7c2', '#c2f0d8', '#cfe3ff', '#e6d1ff'],
    Beach: ['#1d6fa3', '#36a0c2', '#7fd1c4', '#f6e7b4', '#f2c14e'],
    'April Night': ['#001b2e', '#0a4d68', '#088395', '#05bfdb', '#a0f0ff'],
    Temperature: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'],
    C9: ['#ff0000', '#00b000', '#0040ff', '#ffb000', '#ffffff'],
    Yelblu: ['#ffe000', '#80c0ff', '#0040ff'],
    Magenta: ['#ff00ff', '#ff66ff', '#cc00cc'],
    'Orange & Teal': ['#ff7a00', '#ffd0a0', '#1fb6b6', '#0a6b6b']
  };

  function rgbCss([r, g, b]: RGB): string {
    return `rgb(${r} ${g} ${b})`;
  }

  interface Model {
    id: number;
    name: string;
    on: boolean;
    pct: string;
    desc: string;
    paint: string;
    size: string;
    filter: string;
    shadow: string;
    animClass: string;
    dur: number;
  }

  function gradientStops(fxName: string, palName: string): string[] | null {
    if (fxName === 'Solid') return null;
    if (!COLOR_PALETTES.has(palName) && PALETTE_GRADIENTS[palName])
      return PALETTE_GRADIENTS[palName];
    if (RAINBOW_FX.has(fxName)) return RAINBOW;
    return null;
  }

  const models = $derived.by<Model[]>(() =>
    wled.segments.map((seg) => {
      const eff = effectiveColor(seg.col, seg.white);
      const on = wled.on && seg.on;
      const bri = (wled.bri / 255) * (seg.bri / 255);
      const fxName = wled.effects[seg.fx] ?? 'Solid';
      const palName = wled.palettes[seg.pal] ?? 'Default';
      const isSolid = fxName === 'Solid';
      const whiteOnly = seg.col[0] === 0 && seg.col[1] === 0 && seg.col[2] === 0 && seg.white > 0;

      let paint = 'var(--color-muted)';
      let size = '100% 100%';
      let animClass = '';
      let dur = 0;
      let filter = 'none';
      let shadow = 'none';

      if (on) {
        const stops = gradientStops(fxName, palName);
        filter = `brightness(${(0.4 + 0.6 * bri).toFixed(2)}) saturate(1.1)`;
        const a1 = (0.18 + 0.5 * bri).toFixed(2);
        const a2 = (0.1 + 0.35 * bri).toFixed(2);
        const blur1 = Math.round(8 + 10 * bri);
        const blur2 = Math.round(16 + 26 * bri);
        const c = `${eff[0]} ${eff[1]} ${eff[2]}`;
        shadow = `0 0 ${blur1}px rgb(${c} / ${a1}), 0 0 ${blur2}px rgb(${c} / ${a2})`;

        if (stops) {
          paint = `linear-gradient(90deg, ${[...stops, stops[0]].join(', ')})`;
          size = '200% 100%';
          if (animated) {
            animClass = 'anim-scroll';
            dur = +(14 - (seg.sx / 255) * 11).toFixed(1); // ~3–14 s
          }
        } else {
          paint = `linear-gradient(90deg, ${rgbCss(eff)}, ${rgbCss(eff)})`;
          if (!isSolid && animated) {
            animClass = 'anim-pulse';
            dur = +(4.5 - (seg.sx / 255) * 3.3).toFixed(1); // ~1.2–4.5 s
          }
        }
      }

      const desc = !on ? 'Éteint' : isSolid ? (whiteOnly ? 'Blanc 4000K' : 'Couleur fixe') : fxName;

      return {
        id: seg.id,
        name: seg.name,
        on,
        pct: on ? `${Math.round(bri * 100)}%` : '—',
        desc,
        paint,
        size,
        filter,
        shadow,
        animClass,
        dur
      };
    })
  );
</script>

{#if models.length}
  <div class="pv">
    {#each models as m (m.id)}
      <div class="pv-row" title="{m.name} · {m.desc} · {m.pct}">
        <span class="pv-name">{m.name}</span>
        <div
          class="pv-bar {m.animClass}"
          class:off={!m.on}
          style="background: {m.paint}; background-size: {m.size}; filter: {m.filter}; box-shadow: {m.shadow}; animation-duration: {m.dur}s;"
          role="img"
          aria-label="{m.name} : {m.desc}, {m.pct}"
        ></div>
        <span class="pv-pct tabular-nums">{m.pct}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .pv {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pv-row {
    display: grid;
    grid-template-columns: 64px 1fr 34px;
    align-items: center;
    gap: 10px;
  }
  .pv-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pv-pct {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
    text-align: right;
  }

  /* Barre = ruban COB : trait continu diffus avec halo. */
  .pv-bar {
    position: relative;
    height: 18px;
    border-radius: 9999px;
    background-repeat: no-repeat;
    overflow: hidden;
    transition:
      filter var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  /* Tube en verre : reflet haut + ombre basse (donne le volume « diffuseur »). */
  .pv-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
      180deg,
      oklch(1 0 0 / 0.5) 0%,
      oklch(1 0 0 / 0.1) 42%,
      transparent 60%,
      oklch(0.1 0.01 286 / 0.22) 100%
    );
    pointer-events: none;
  }
  .pv-bar.off {
    background: var(--color-muted) !important;
    box-shadow: none !important;
    filter: none !important;
    opacity: 0.7;
  }

  .anim-scroll {
    animation-name: pv-scroll;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  .anim-pulse {
    animation-name: pv-pulse;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
    animation-direction: alternate;
  }
  @keyframes pv-scroll {
    to {
      background-position: -200% 0;
    }
  }
  @keyframes pv-pulse {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }

  /* Respect strict de la réduction de mouvement (par-dessus la préférence app). */
  @media (prefers-reduced-motion: reduce) {
    .pv-bar {
      animation: none !important;
    }
  }
</style>
