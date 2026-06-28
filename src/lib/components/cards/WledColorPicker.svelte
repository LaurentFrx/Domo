<script lang="ts">
  /**
   * Sélecteur de COULEUR (teinte) pour un segment WLED — distinct du canal blanc
   * 4000K (slider séparé dans la carte). Teinte + saturation (le blanc se règle
   * via le canal W dédié). Émet une couleur RVB réelle (les LED ont besoin de
   * vrai RGB, pas d'OKLCH). « Couleur off » = pas de teinte (col 0,0,0).
   */
  import type { RGB } from '$stores/wled.svelte';

  interface Props {
    color: RGB;
    disabled?: boolean;
    onpick: (rgb: RGB) => void;
  }

  let { color, disabled = false, onpick }: Props = $props();

  // Presets COLORÉS uniquement (le blanc passe par le canal W dédié).
  const PRESETS: { name: string; rgb: RGB }[] = [
    { name: 'Ambre', rgb: [255, 150, 40] },
    { name: 'Corail', rgb: [255, 70, 70] },
    { name: 'Rose', rgb: [255, 80, 150] },
    { name: 'Magenta', rgb: [230, 40, 200] },
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

  function rgbToHsv([r, g, b]: RGB): { h: number; s: number; v: number } {
    const rn = r / 255,
      gn = g / 255,
      bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
  }

  const hsv = $derived(rgbToHsv(color));
  const hue = $derived(Math.round(hsv.h));
  const satPct = $derived(Math.round(hsv.s * 100));
  const achromatic = $derived(hsv.s < 0.04 || hsv.v === 0); // gris / éteint
  const css = $derived(`rgb(${color[0]} ${color[1]} ${color[2]})`);
  // Valeur de référence (V) : préserve la brillance courante, sauf si éteint → 1.
  const baseV = $derived(hsv.v > 0 ? hsv.v : 1);
  // Rail de saturation : du blanc vers la couleur pleinement saturée de la teinte.
  const fullHue = $derived(hsvToRgb(hsv.h, 1, 1));
  const satTrack = $derived(
    `linear-gradient(90deg, #fff, rgb(${fullHue[0]} ${fullHue[1]} ${fullHue[2]}))`
  );

  function sameRgb(a: RGB, b: RGB): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  }

  function onHue(e: Event) {
    if (disabled) return;
    const h = +(e.currentTarget as HTMLInputElement).value;
    // Préserve la saturation/valeur courantes (ne brutalise plus la couleur).
    const s = hsv.s > 0 ? hsv.s : 1;
    onpick(hsvToRgb(h, s, baseV));
  }
  function onSat(e: Event) {
    if (disabled) return;
    const s = +(e.currentTarget as HTMLInputElement).value / 100;
    onpick(hsvToRgb(hsv.h, s, baseV));
  }
  function pickPreset(rgb: RGB) {
    if (disabled) return;
    onpick(rgb);
  }
</script>

<div class="flex flex-col gap-2.5" class:opacity-50={disabled}>
  <div class="flex items-center gap-2.5">
    <span
      class="color-preview shrink-0"
      style="background: {css};"
      role="img"
      aria-label="Couleur actuelle : teinte {hue}°, saturation {satPct}%"
    ></span>
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <input
        type="range"
        class="hue-range"
        min="0"
        max="359"
        value={hue}
        {disabled}
        oninput={onHue}
        aria-label="Teinte"
        aria-valuetext="{hue}°"
      />
      <input
        type="range"
        class="sat-range"
        min="0"
        max="100"
        value={satPct}
        {disabled}
        oninput={onSat}
        aria-label="Saturation"
        aria-valuetext="{satPct} %"
        style="--sat-track: {satTrack};"
      />
    </div>
  </div>

  <div class="swatches">
    {#each PRESETS as p (p.name)}
      <button
        type="button"
        class="swatch"
        class:active={sameRgb(color, p.rgb)}
        style="background: rgb({p.rgb[0]} {p.rgb[1]} {p.rgb[2]});"
        title={p.name}
        aria-label={p.name}
        aria-pressed={sameRgb(color, p.rgb)}
        {disabled}
        onclick={() => pickPreset(p.rgb)}
      ></button>
    {/each}
    <button
      type="button"
      class="swatch swatch-off"
      class:active={achromatic}
      title="Sans teinte (blanc seul)"
      aria-label="Couleur off — blanc seul"
      aria-pressed={achromatic}
      {disabled}
      onclick={() => pickPreset([0, 0, 0])}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      >
        <path d="M5 5l14 14" />
      </svg>
    </button>
  </div>
</div>

<style>
  .color-preview {
    width: 38px;
    height: 38px;
    border-radius: var(--radius-lg);
    border: 1px solid oklch(1 0 0 / 0.25);
    box-shadow:
      inset 0 1px 2px oklch(1 0 0 / 0.4),
      0 1px 4px oklch(0.1 0.01 286 / 0.25);
  }

  .hue-range,
  .sat-range {
    width: 100%;
    height: 14px;
    appearance: none;
    border-radius: 9999px;
    cursor: pointer;
  }
  .hue-range {
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
  .sat-range {
    background: var(--sat-track);
  }
  .hue-range::-webkit-slider-thumb,
  .sat-range::-webkit-slider-thumb {
    appearance: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: oklch(0.99 0.004 286);
    border: 2px solid oklch(0.3 0.02 286 / 0.5);
    cursor: pointer;
    box-shadow: 0 1px 4px oklch(0 0 0 / 0.35);
  }
  .hue-range::-moz-range-thumb,
  .sat-range::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: oklch(0.99 0.004 286);
    border: 2px solid oklch(0.3 0.02 286 / 0.5);
    cursor: pointer;
  }
  .hue-range:focus-visible,
  .sat-range:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 8px;
  }
  .swatch {
    aspect-ratio: 1;
    min-height: 40px;
    border-radius: var(--radius-md);
    border: 1px solid oklch(1 0 0 / 0.2);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    box-shadow: inset 0 1px 2px oklch(1 0 0 / 0.3);
    transition: transform var(--duration-fast) var(--ease-default);
  }
  .swatch.active {
    outline: 2.5px solid var(--color-primary);
    outline-offset: 2px;
  }
  .swatch:active {
    transform: scale(0.9);
  }
  .swatch:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .swatch:disabled {
    cursor: not-allowed;
  }
  .swatch-off {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--color-muted);
    color: var(--color-muted-fg);
    box-shadow: none;
  }
</style>
