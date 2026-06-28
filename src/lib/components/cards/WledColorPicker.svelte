<script lang="ts">
  /**
   * Sélecteur de couleur pour un segment WLED.
   * Presets rapides (blanc chaud + accents) + slider de teinte (rail arc-en-ciel).
   * Émet une couleur RVB réelle (les LED ont besoin de vrai RGB, pas d'OKLCH).
   */
  import type { RGB } from '$stores/wled.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    color: RGB;
    disabled?: boolean;
    onpick: (rgb: RGB) => void;
  }

  let { color, disabled = false, onpick }: Props = $props();

  // Presets : blanc chaud d'abord (usage terrasse), puis accents lumineux.
  const PRESETS: { name: string; rgb: RGB }[] = [
    { name: 'Blanc chaud', rgb: [255, 175, 95] },
    { name: 'Blanc', rgb: [255, 245, 230] },
    { name: 'Ambre', rgb: [255, 150, 40] },
    { name: 'Corail', rgb: [255, 70, 70] },
    { name: 'Magenta', rgb: [255, 40, 200] },
    { name: 'Violet', rgb: [150, 70, 255] },
    { name: 'Bleu', rgb: [40, 90, 255] },
    { name: 'Cyan', rgb: [0, 200, 220] },
    { name: 'Vert', rgb: [40, 230, 90] }
  ];

  function hsvToRgb(h: number, s: number, v: number): RGB {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0,
      g = 0,
      b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHue([r, g, b]: RGB): number {
    const rn = r / 255,
      gn = g / 255,
      bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    if (d === 0) return 0;
    let h = 0;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  const hue = $derived(Math.round(rgbToHue(color)));
  const css = $derived(`rgb(${color[0]} ${color[1]} ${color[2]})`);

  function pickPreset(rgb: RGB) {
    if (disabled) return;
    onpick(rgb);
  }

  function onHue(e: Event) {
    if (disabled) return;
    const h = +(e.currentTarget as HTMLInputElement).value;
    onpick(hsvToRgb(h, 1, 1));
  }
</script>

<div class="flex flex-col gap-2.5" class:opacity-50={disabled}>
  <div class="flex items-center gap-2.5">
    <span class="color-preview shrink-0" style="background: {css};" aria-label="Couleur actuelle"
    ></span>
    <input
      type="range"
      class="hue-range"
      min="0"
      max="359"
      value={hue}
      {disabled}
      oninput={onHue}
      aria-label="Teinte"
    />
  </div>
  <div class="swatches">
    {#each PRESETS as p (p.name)}
      <button
        type="button"
        class="swatch"
        style="background: rgb({p.rgb[0]} {p.rgb[1]} {p.rgb[2]});"
        title={p.name}
        aria-label={p.name}
        {disabled}
        onclick={() => pickPreset(p.rgb)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .color-preview {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-lg);
    border: 1px solid oklch(1 0 0 / 0.25);
    box-shadow:
      inset 0 1px 2px oklch(1 0 0 / 0.4),
      0 1px 4px oklch(0.1 0.01 286 / 0.25);
  }

  .hue-range {
    flex: 1;
    height: 12px;
    appearance: none;
    border-radius: 9999px;
    cursor: pointer;
    background: linear-gradient(
      90deg,
      #ff0000 0%,
      #ffff00 17%,
      #00ff00 33%,
      #00ffff 50%,
      #0000ff 67%,
      #ff00ff 83%,
      #ff0000 100%
    );
  }
  .hue-range::-webkit-slider-thumb {
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid oklch(0.3 0.02 286 / 0.5);
    cursor: pointer;
    box-shadow: 0 1px 4px oklch(0 0 0 / 0.35);
  }
  .hue-range::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid oklch(0.3 0.02 286 / 0.5);
    cursor: pointer;
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 6px;
  }
  @media (max-width: 380px) {
    .swatches {
      grid-template-columns: repeat(9, 1fr);
      gap: 4px;
    }
  }
  .swatch {
    aspect-ratio: 1;
    border-radius: var(--radius-md);
    border: 1px solid oklch(1 0 0 / 0.2);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    box-shadow: inset 0 1px 2px oklch(1 0 0 / 0.3);
    transition: transform var(--duration-fast) var(--ease-default);
  }
  .swatch:active {
    transform: scale(0.9);
  }
  .swatch:disabled {
    cursor: not-allowed;
  }
</style>
