<script lang="ts">
  /**
   * LA barre de lumière — héros et signature de la carte terrasse.
   * Une barre par segment, rendue façon COB RGBW : trait CONTINU et diffus
   * (pas de points) avec halo (bloom). Reflète en direct la couleur effective
   * (RGB + blanc 4000K atténué), la luminosité (maître × segment), l'état
   * on/off et la FAMILLE d'effet : fixe / dégradé qui défile / balayage /
   * scintillement / pulsation. Aperçu INDICATIF.
   *
   * En mode « Par ligne » (`selectable`), la barre EST le sélecteur : toucher
   * une ligne l'active pour les réglages — pas d'onglets redondants ailleurs.
   *
   * Animations gardées par `animated` (préférence app) + @media reduced-motion,
   * et MISES EN PAUSE quand l'onglet passe en arrière-plan (document.hidden).
   *
   * MODE MUSIQUE RÉACTIF : la barre s'anime avec le niveau sonore que le
   * SERVEUR diffuse à tous les appareils (SSE /api/wled/music/live, 12,5 Hz —
   * la même donnée que le stream sound-sync du ruban). Piloté par variable
   * CSS (--mvol) mise à jour en requestAnimationFrame, hors réactivité Svelte
   * (zéro re-render à 60 fps).
   */
  import { wled, previewColor, type RGB } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';

  interface Props {
    /** Animer les effets dynamiques (sinon image fixe). */
    animated?: boolean;
    /** Les barres deviennent des boutons de sélection de ligne. */
    selectable?: boolean;
    /** Ligne sélectionnée (mode selectable). */
    selectedId?: number;
    onselect?: (id: number) => void;
  }
  let { animated = true, selectable = false, selectedId = 0, onselect }: Props = $props();

  // Pause des animations quand la page n'est pas visible (règle Domo).
  let hidden = $state(false);
  $effect(() => {
    if (typeof document === 'undefined') return;
    hidden = document.visibilityState === 'hidden';
    const onVis = () => (hidden = document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });

  // ─── Suivi musique : la barre bouge comme le ruban ───
  // Source UNIQUE : le niveau sonore 12,5 Hz du SSE /api/wled/music/live
  // (wledMusic.liveLevel/livePeak — champs non réactifs, lus dans la boucle
  // rAF). Même donnée pour tous les appareils, y compris celui qui joue.
  let pvEl = $state<HTMLDivElement | null>(null);
  const live = $derived(wledMusic.reactive && wledMusic.playing && animated && !hidden);

  $effect(() => {
    if (!live || !pvEl) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = pvEl;
    let raf = 0;
    let smooth = 0.4;
    const tick = () => {
      let v = wledMusic.liveLevel;
      if (wledMusic.livePeak) v = Math.max(v, 0.95); // flash sur les temps forts
      // Attaque instantanée, retombée douce (comme un vrai VU).
      smooth = v > smooth ? v : smooth * 0.88 + v * 0.12;
      el.style.setProperty('--mvol', smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.setProperty('--mvol', '0.5'); // repos neutre
    };
  });

  // Palettes « couleur » (= utilisent la couleur du segment, pas un dégradé).
  const COLOR_PALETTES = new Set([
    'Default',
    'Random Cycle',
    '* Random Cycle',
    'Color 1',
    '* Color 1',
    'Colors 1&2',
    '* Colors 1&2',
    'Color Gradient',
    '* Color Gradient',
    'Colors Only'
  ]);

  const RAINBOW = ['#ff0040', '#ff8000', '#ffff00', '#00ff40', '#00ffff', '#0040ff', '#8000ff'];

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
    'Noise Pal'
  ]);

  // Effets à mouvement spatial (un point/segment qui balaye).
  const SWEEP_FX = new Set([
    'Scan',
    'Scan Dual',
    'Scanner',
    'Scanner Dual',
    'Wipe',
    'Wipe Random',
    'Tri Wipe',
    'Sweep',
    'Sweep Random',
    'Running',
    'Running Dual',
    'Chase',
    'Chase Random',
    'Chase Rainbow',
    'Chase Flash',
    'Chase Flash Rnd',
    'Chase 2',
    'Chase 3',
    'Lighthouse',
    'Loading',
    'Meteor',
    'Meteor Smooth',
    'Multi Comet',
    'Drip',
    'Sinelon',
    'Sinelon Dual',
    'Sinelon Rainbow',
    'Two Dots',
    'Stream',
    'Stream 2',
    'Rolling Balls',
    'Bouncing Balls',
    'Popcorn',
    'ICU',
    'Railway',
    'Android',
    'Tetrix',
    'Percent'
  ]);

  // Effets « scintillants » (flamme, étincelles, strobe…).
  const FLICKER_FX = new Set([
    'Fire 2012',
    'Fire Flicker',
    'Candle',
    'Candle Multi',
    'Lightning',
    'Halloween Eyes',
    'Fireworks',
    'Fireworks Starburst',
    'Fireworks 1D',
    'Sparkle',
    'Sparkle Dark',
    'Sparkle+',
    'Glitter',
    'Solid Glitter',
    'Strobe',
    'Strobe Rainbow',
    'Strobe Mega',
    'Blink',
    'Blink Rainbow',
    'Twinkle',
    'Twinklefox',
    'Twinklecat',
    'Twinkleup',
    'Fairytwinkle',
    'Fairy',
    'Colortwinkles',
    'Dissolve',
    'Dissolve Rnd',
    'Random Colors'
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
    Lava: ['#1a0000', '#5a0000', '#b30000', '#ff6a00', '#ffd000'],
    Fire: ['#1a0000', '#7a0000', '#ff3000', '#ff9a00', '#ffe000'],
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

  // Libellés FR des effets courants (sinon nom brut WLED).
  const FX_FR: Record<string, string> = {
    Solid: 'Couleur fixe',
    Breathe: 'Respiration',
    Fade: 'Fondu',
    Candle: 'Bougie',
    'Candle Multi': 'Bougies',
    'Fire 2012': 'Feu',
    'Fire Flicker': 'Feu',
    Colorloop: 'Boucle de couleurs',
    Colorwaves: 'Vagues de couleur',
    Blends: 'Fondu de couleurs',
    Rainbow: 'Arc-en-ciel',
    'Rainbow Runner': 'Arc-en-ciel',
    Aurora: 'Aurore',
    Pacifica: 'Océan',
    Twinklefox: 'Scintillement',
    Twinkle: 'Scintillement',
    Scanner: 'Balayage',
    Scan: 'Balayage',
    Meteor: 'Comète',
    'Multi Comet': 'Comètes',
    Sparkle: 'Étincelles',
    Glitter: 'Paillettes',
    Blink: 'Clignotement',
    Strobe: 'Stroboscope',
    Plasma: 'Plasma',
    Lightning: 'Éclair',
    Heartbeat: 'Battement',
    Drip: 'Gouttes'
  };

  function rgbCss([r, g, b]: RGB): string {
    return `rgb(${r} ${g} ${b})`;
  }

  type Family = 'solid' | 'scroll' | 'sweep' | 'flicker' | 'pulse';

  interface Model {
    id: number;
    name: string;
    on: boolean;
    desc: string;
    paint: string;
    size: string;
    filter: string;
    fillAnim: string;
    fillDur: number;
    sweep: boolean;
    spotPaint: string;
    spotDur: number;
    shadow: string;
  }

  function gradientStops(fxName: string, palName: string): string[] | null {
    const bare = palName.replace(/^\* /, '');
    if (!COLOR_PALETTES.has(palName) && PALETTE_GRADIENTS[bare]) return PALETTE_GRADIENTS[bare];
    if (RAINBOW_FX.has(fxName)) return RAINBOW;
    return null;
  }

  function familyOf(fxName: string, stops: string[] | null): Family {
    if (fxName === 'Solid') return 'solid';
    if (stops) return 'scroll';
    if (SWEEP_FX.has(fxName)) return 'sweep';
    if (FLICKER_FX.has(fxName)) return 'flicker';
    return 'pulse';
  }

  const models = $derived.by<Model[]>(() =>
    wled.segments.map((seg) => {
      const eff = previewColor(seg.col, seg.white);
      const on = wled.on && seg.on;
      const bri = (wled.bri / 255) * (seg.bri / 255);
      const fxName = wled.effects[seg.fx] ?? 'Solid';
      const palName = wled.palettes[seg.pal] ?? 'Default';
      const whiteOnly = seg.col[0] === 0 && seg.col[1] === 0 && seg.col[2] === 0 && seg.white > 0;
      const stops = on ? gradientStops(fxName, palName) : null;
      const family = familyOf(fxName, stops);

      let paint = 'transparent';
      let size = '100% 100%';
      let fillAnim = '';
      let fillDur = 0;
      let sweep = false;
      let spotPaint = 'transparent';
      let spotDur = 0;
      let filter = 'none';
      let shadow = 'none';

      if (on && live) {
        // Mode musique réactif : la barre est pilotée par la var CSS --mvol
        // (mise à jour en rAF depuis la timeline du morceau — les mêmes
        // données que le ruban). Pas d'animation CSS générique par-dessus.
        const c = `${eff[0]} ${eff[1]} ${eff[2]}`;
        paint = `linear-gradient(90deg, ${rgbCss(eff)}, ${rgbCss(eff)})`;
        filter = `brightness(calc(0.2 + var(--mvol, 0.4) * ${(1.25 * (0.35 + 0.65 * bri)).toFixed(2)})) saturate(1.15)`;
        shadow = `0 0 calc(4px + var(--mvol, 0.3) * 18px) rgb(${c} / 0.55), 0 0 calc(10px + var(--mvol, 0.3) * 36px) rgb(${c} / 0.30)`;
      } else if (on) {
        // Luminosité bakée dans le fill (plancher bas) — pas sur le conteneur,
        // sinon le reflet verre (::after) serait assombri lui aussi.
        filter = `brightness(${(0.18 + 0.82 * bri).toFixed(2)}) saturate(1.1)`;
        const a1 = (0.12 + 0.5 * bri).toFixed(2);
        const a2 = (0.06 + 0.32 * bri).toFixed(2);
        const blur1 = Math.round(6 + 10 * bri);
        const blur2 = Math.round(14 + 26 * bri);
        const c = `${eff[0]} ${eff[1]} ${eff[2]}`;
        shadow = `0 0 ${blur1}px rgb(${c} / ${a1}), 0 0 ${blur2}px rgb(${c} / ${a2})`;

        if (family === 'scroll' && stops) {
          paint = `linear-gradient(90deg, ${[...stops, stops[0]].join(', ')})`;
          size = '200% 100%';
          if (animated) {
            fillAnim = 'anim-scroll';
            fillDur = +(14 - (seg.sx / 255) * 11).toFixed(1); // ~3–14 s
          }
        } else {
          paint = `linear-gradient(90deg, ${rgbCss(eff)}, ${rgbCss(eff)})`;
          if (animated && family === 'pulse') {
            fillAnim = 'anim-pulse';
            fillDur = +(4.5 - (seg.sx / 255) * 3.3).toFixed(1);
          } else if (animated && family === 'flicker') {
            fillAnim = 'anim-flicker';
            fillDur = +(1.6 - (seg.sx / 255) * 1.2).toFixed(2);
          } else if (family === 'sweep') {
            sweep = true;
            const sp: RGB = [
              Math.min(255, eff[0] + 110),
              Math.min(255, eff[1] + 110),
              Math.min(255, eff[2] + 110)
            ];
            spotPaint = `linear-gradient(90deg, transparent, ${rgbCss(sp)} 50%, transparent)`;
            if (animated) spotDur = +(5 - (seg.sx / 255) * 3.8).toFixed(1);
          }
        }
      }

      // En mode musique, l'état parlant est le STYLE suivi, pas l'effet interne
      // (en pause le module repasse en Solid → « Couleur fixe » serait trompeur).
      // Mode musique : les ÉTATS vivent ici (seule ligne assez large pour les
      // écrire en entier) ; le STYLE, lui, est déjà surligné dans la grille
      // juste en dessous — ne pas le répéter.
      const desc = !on
        ? 'Éteint'
        : wledMusic.enabled
          ? wledMusic.analyzing
            ? 'Musique · analyse du morceau…'
            : !wledMusic.trackKey
              ? 'Musique · en attente de lecture'
              : wledMusic.playing
                ? 'Musique'
                : 'Musique · en pause'
          : whiteOnly && fxName === 'Solid'
            ? 'Blanc 4000K'
            : (FX_FR[fxName] ?? fxName);

      return {
        id: seg.id,
        name: seg.name,
        on,
        desc,
        paint,
        size,
        filter,
        fillAnim,
        fillDur,
        sweep,
        spotPaint,
        spotDur,
        shadow
      };
    })
  );

  const multi = $derived(models.length > 1);
</script>

{#if models.length}
  <div class="pv" class:paused={hidden} bind:this={pvEl}>
    {#each models as m (m.id)}
      {#snippet bar()}
        <div class="pv-bar" class:off={!m.on} style="box-shadow: {m.shadow};" aria-hidden="true">
          <div
            class="pv-fill {m.fillAnim}"
            style="background: {m.paint}; background-size: {m.size}; filter: {m.filter}; animation-duration: {m.fillDur}s;"
          ></div>
          {#if m.sweep}
            <div
              class="pv-spot"
              style="background: {m.spotPaint}; animation-duration: {m.spotDur}s;"
            ></div>
          {/if}
        </div>
      {/snippet}

      {#if selectable && multi}
        <!-- La barre EST le sélecteur de ligne (pas d'onglets redondants). -->
        <button
          type="button"
          class="pv-row pv-select"
          class:selected={m.id === selectedId}
          aria-pressed={m.id === selectedId}
          aria-label="Régler {m.name} — {m.desc}"
          onclick={() => onselect?.(m.id)}
        >
          <span class="pv-name">{m.name}</span>
          {@render bar()}
        </button>
      {:else}
        <div class="pv-row" role="img" aria-label="{multi ? m.name + ' : ' : ''}{m.desc}">
          {#if multi}<span class="pv-name">{m.name}</span>{/if}
          {@render bar()}
        </div>
      {/if}
    {/each}
    {#if !multi && models[0].on}
      <span class="pv-desc">{models[0].desc}</span>
    {/if}
  </div>
{/if}

<style>
  .pv {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pv-row {
    display: grid;
    grid-template-columns: 1fr;
    align-items: center;
    gap: 10px;
    /* Reset bouton (mode sélection) */
    padding: 0;
    border: none;
    background: transparent;
    text-align: left;
    width: 100%;
  }
  .pv-row:has(.pv-name) {
    grid-template-columns: 56px 1fr;
  }
  .pv-select {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    border-radius: var(--radius-lg);
    /* Cible tactile ≥ 40px : la barre fait 26px, le padding vertical complète
       (règle Domo). Marge négative pour ne pas espacer visuellement les lignes. */
    padding-block: 7px;
    margin-block: -7px;
  }
  .pv-select .pv-bar {
    outline: 2px solid transparent;
    outline-offset: 3px;
    transition: outline-color var(--duration-fast) var(--ease-default);
  }
  .pv-select.selected .pv-bar {
    outline-color: var(--color-primary);
  }
  .pv-select.selected .pv-name {
    color: var(--color-fg);
  }
  .pv-select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .pv-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pv-desc {
    font-size: 11px;
    color: var(--color-muted-fg);
  }

  /* Barre = ruban COB : trait continu diffus avec halo. */
  .pv-bar {
    position: relative;
    height: 26px;
    border-radius: 9999px;
    overflow: hidden;
    background: transparent;
    transition: box-shadow var(--duration-normal) var(--ease-default);
  }
  /* Couche de couleur (reçoit la luminosité + l'animation). */
  .pv-fill {
    position: absolute;
    inset: 0;
    background-repeat: repeat-x;
    transition: filter var(--duration-normal) var(--ease-default);
  }
  /* Point lumineux des effets de balayage. */
  .pv-spot {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 32%;
    transform: translateX(-120%);
    filter: blur(1px);
    will-change: transform;
  }
  /* Tube en verre : reflet haut + ombre basse — PAS filtré (hors .pv-fill). */
  .pv-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
      180deg,
      oklch(1 0 0 / 0.45) 0%,
      oklch(1 0 0 / 0.08) 42%,
      transparent 60%,
      oklch(0.1 0.01 286 / 0.2) 100%
    );
    pointer-events: none;
  }
  .pv-bar.off {
    background: var(--color-muted);
    opacity: 0.5;
    box-shadow: none !important;
  }
  .pv-bar.off::after {
    opacity: 0.3;
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
  .anim-flicker {
    animation-name: pv-flicker;
    animation-timing-function: steps(2, end);
    animation-iteration-count: infinite;
  }
  .pv-spot {
    animation-name: pv-sweep;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
  }
  @keyframes pv-scroll {
    to {
      background-position: -200% 0;
    }
  }
  @keyframes pv-pulse {
    from {
      opacity: 0.5;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes pv-flicker {
    0% {
      opacity: 0.55;
    }
    25% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
    75% {
      opacity: 0.95;
    }
    100% {
      opacity: 0.6;
    }
  }
  @keyframes pv-sweep {
    from {
      transform: translateX(-120%);
    }
    to {
      transform: translateX(320%);
    }
  }

  /* Pause en arrière-plan + respect strict de la réduction de mouvement. */
  .pv.paused .pv-fill,
  .pv.paused .pv-spot {
    animation-play-state: paused;
  }
  @media (prefers-reduced-motion: reduce) {
    .pv-fill,
    .pv-spot {
      animation: none !important;
    }
    .pv-spot {
      display: none;
    }
  }
</style>
