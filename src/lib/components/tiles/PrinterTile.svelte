<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { printer, type InkColor } from '$stores/printer.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** La prise Zigbee qui alimente l'imprimante. */
    plug: ZigbeeDevice;
  }

  let { plug }: Props = $props();

  const isOn = $derived(plug.state.state === 'ON');
  const power = $derived<number | null>(
    typeof plug.state.power === 'number' ? (plug.state.power as number) : null
  );

  function onTogglePlug() {
    if (!plug.available) return;
    haptic('light');
    zigbee.toggle(plug.friendlyName);
  }

  // ─── Couleurs CMYK : pour chaque cartouche, on précalcule :
  // - base : couleur pleine (la barre de fill)
  // - track : couleur très diluée (le fond de la pill)
  // - glow : couleur diffuse pour le box-shadow extérieur
  // - light : variante un poil éclaircie pour le dégradé du fill
  // Pas de color-mix() dans les calculs (mal supporté sur Safari iOS
  // dans certains contextes — notamment à l'intérieur des gradients).
  const INK: Record<InkColor, { base: string; track: string; glow: string; light: string }> = {
    BK: {
      base: 'oklch(0.32 0.005 280)',
      track: 'oklch(0.32 0.005 280 / 0.20)',
      glow: 'oklch(0.45 0.01 280 / 0.45)',
      light: 'oklch(0.45 0.005 280)'
    },
    C: {
      base: 'oklch(0.70 0.20 220)',
      track: 'oklch(0.70 0.20 220 / 0.20)',
      glow: 'oklch(0.70 0.20 220 / 0.55)',
      light: 'oklch(0.82 0.18 220)'
    },
    M: {
      base: 'oklch(0.62 0.27 350)',
      track: 'oklch(0.62 0.27 350 / 0.20)',
      glow: 'oklch(0.62 0.27 350 / 0.55)',
      light: 'oklch(0.78 0.22 350)'
    },
    Y: {
      base: 'oklch(0.86 0.18 95)',
      track: 'oklch(0.86 0.18 95 / 0.22)',
      glow: 'oklch(0.86 0.18 95 / 0.55)',
      light: 'oklch(0.95 0.16 95)'
    }
  };

  const lastUpdateLabel = $derived.by(() => {
    const d = printer.lastUpdate;
    if (!d) return null;
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 90) return "à l'instant";
    const min = Math.round(sec / 60);
    if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `il y a ${h} h`;
    return `il y a ${Math.round(h / 24)} j`;
  });
</script>

<article
  class="printer-tile flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
  class:opacity-50={!plug.available}
  class:printer-on={isOn}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Header : icône + nom + état/conso + toggle -->
  <header class="flex items-center gap-3">
    <span
      class="printer-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn
        ? 'var(--color-consumption)'
        : 'var(--color-consumption-muted)'}; color: {isOn ? 'white' : 'var(--color-consumption)'};"
      aria-hidden="true"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" rx="0.5" />
      </svg>
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[13px] leading-tight font-semibold" style="color: var(--color-fg);">
        Imprimante Epson
      </span>
      <span class="text-[10px]" style="color: var(--color-muted-fg);">
        {#if isOn && power !== null}
          {power.toFixed(0)} W
        {:else if isOn}
          Sous tension
        {:else}
          Éteinte
        {/if}
        {#if printer.inks.length > 0 && !printer.online && lastUpdateLabel}
          · niveaux {lastUpdateLabel}
        {/if}
      </span>
    </div>
    <button
      type="button"
      class="toggle-track shrink-0"
      class:toggle-on={isOn}
      role="switch"
      aria-checked={isOn}
      aria-label="Basculer la prise imprimante"
      onclick={onTogglePlug}
      disabled={!plug.available}
    >
      <span class="toggle-knob"></span>
    </button>
  </header>

  <!-- Bandeau pills CMYK : 4 pills sur une seule ligne, barre de fill proportionnelle -->
  {#if printer.inks.length > 0}
    <div class="ink-pills">
      {#each printer.inks as ink (ink.color)}
        {@const c = INK[ink.color]}
        <div
          class="ink-pill"
          style="--ink-base: {c.base}; --ink-light: {c.light}; --ink-track: {c.track}; --ink-glow: {c.glow}; --ink-percent: {Math.max(
            0,
            Math.min(100, ink.percent)
          )}%;"
          title="{ink.label} · {ink.percent}%"
        >
          <span class="ink-pill-fill" aria-hidden="true"></span>
          <span class="ink-pill-pct" class:ink-low={ink.percent < 10}>
            {ink.percent}<span class="ink-pill-unit">%</span>
          </span>
        </div>
      {/each}
    </div>
  {:else}
    <button
      type="button"
      class="ink-error-btn text-left text-[11px]"
      style="color: var(--color-muted-fg);"
      onclick={() => printer.refresh()}
    >
      {#if printer.status === 'unconfigured'}
        Niveaux d'encre indisponibles — `PRINTER_HOST` non configuré.
      {:else if printer.status === 'polling'}
        Lecture des niveaux d'encre…
      {:else}
        Imprimante jamais jointe — {printer.lastError ?? 'erreur réseau'}.
        <span style="color: var(--color-primary);">Tap pour réessayer</span>
      {/if}
    </button>
  {/if}
</article>

<style>
  .printer-tile {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .printer-tile:hover {
    border-color: var(--color-border-strong);
  }
  /* ─── Glow néon quand l'imprimante est allumée (idem switches ON) ─── */
  /* Utilise oklch(... / alpha) directement plutôt que color-mix() pour
     compatibilité Safari iOS. */
  .printer-on {
    border-color: var(--color-consumption);
    box-shadow:
      0 0 14px oklch(0.546 0.215 262 / 0.5),
      0 0 32px oklch(0.546 0.215 262 / 0.22);
  }
  .printer-on .printer-icon {
    box-shadow:
      0 0 10px oklch(0.546 0.215 262 / 0.55),
      0 0 20px oklch(0.546 0.215 262 / 0.3);
  }
  .printer-icon {
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }

  /* ─── 4 pills CMYK sur UNE SEULE ligne ─── */
  .ink-pills {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .ink-pill {
    position: relative;
    height: 30px;
    border-radius: 9999px;
    overflow: hidden;
    background: var(--ink-track);
    border: 1px solid var(--ink-base);
    /* glow extérieur — pas de color-mix, pas de transparent : Safari-safe */
    box-shadow: 0 0 10px var(--ink-glow);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--duration-fast) var(--ease-default);
    isolation: isolate; /* nouveau stacking context — fiabilise Safari */
  }

  /* Fill : élément réel (pas ::before) — Safari iOS gère plus fiablement */
  .ink-pill-fill {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--ink-percent, 0%);
    background-color: var(--ink-base);
    background-image: linear-gradient(to right, var(--ink-light), var(--ink-base));
    border-radius: inherit;
    z-index: 0;
    transition: width 600ms var(--ease-out);
    pointer-events: none;
  }

  .ink-pill:hover {
    transform: translateY(-1px) scale(1.03);
  }

  .ink-pill-pct {
    position: relative;
    z-index: 1;
    font-size: 13px;
    font-weight: 700;
    color: #ffffff;
    text-shadow:
      0 1px 2px oklch(0.1 0.01 286 / 0.6),
      0 0 4px oklch(0.1 0.01 286 / 0.4);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .ink-pill-pct.ink-low {
    color: oklch(0.92 0.08 30);
  }
  .ink-pill-unit {
    font-size: 9px;
    font-weight: 600;
    opacity: 0.85;
    margin-left: 1px;
  }

  .ink-error-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* Toggle (cohérent SwitchTile) */
  .toggle-track {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .toggle-on {
    background: var(--color-consumption);
    border-color: var(--color-consumption);
  }
  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.2);
    transform: translateY(-50%);
    transition: left var(--duration-normal) var(--ease-spring);
  }
  .toggle-on .toggle-knob {
    left: calc(100% - 21px);
  }
  .toggle-track:disabled {
    cursor: not-allowed;
  }
</style>
