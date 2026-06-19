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
</script>

<article
  class="printer-tile flex items-center gap-3 rounded-[var(--radius-xl)] border px-3 py-2"
  class:opacity-50={!plug.available}
  class:printer-on={isOn}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Icône-interrupteur (touch = on/off) + titre DESSOUS, comme les tuiles du dessus. -->
  <div class="flex shrink-0 flex-col items-center gap-1">
    <button
      type="button"
      class="printer-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn
        ? 'var(--color-consumption)'
        : 'var(--color-consumption-muted)'}; color: {isOn ? 'white' : 'var(--color-consumption)'};"
      role="switch"
      aria-checked={isOn}
      aria-label="Allumer ou éteindre l'imprimante"
      onclick={onTogglePlug}
      disabled={!plug.available}
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
    </button>
    <span
      class="text-center text-[11px] leading-tight font-semibold sm:text-[13px]"
      style="color: var(--color-fg);"
    >
      Imprimante
    </span>
  </div>

  <!-- Niveaux d'encre CMYK : 4 jauges VERTICALES (remplies de bas en haut) + % dessous -->
  {#if printer.inks.length > 0}
    <div class="ink-pills">
      {#each printer.inks as ink (ink.color)}
        {@const c = INK[ink.color]}
        {@const pct = Math.max(0, Math.min(100, ink.percent))}
        <div class="ink-col" title="{ink.label} · {ink.percent}%">
          <div
            class="ink-pill"
            style="--ink-base: {c.base}; --ink-light: {c.light}; --ink-track: {c.track}; --ink-glow: {c.glow}; --ink-percent: {pct}%;"
          >
            <span class="ink-pill-fill" aria-hidden="true"></span>
          </div>
          <span class="ink-pct" class:ink-low={ink.percent < 10}>
            {ink.percent}<span class="ink-unit">%</span>
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
  /* L'icône EST le bouton on/off → curseur + retour tactile. */
  .printer-icon {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .printer-icon:active:not(:disabled) {
    transform: scale(0.94);
  }
  .printer-icon:disabled {
    cursor: not-allowed;
  }

  /* ─── 4 jauges d'encre CMYK VERTICALES (capsules remplies de bas en haut) ─── */
  .ink-pills {
    display: grid;
    flex: 1;
    grid-template-columns: repeat(4, 22px);
    gap: 10px;
    justify-content: center;
  }
  .ink-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .ink-pill {
    position: relative;
    width: 100%;
    height: 40px;
    border-radius: 9999px;
    overflow: hidden;
    background: var(--ink-track);
    border: 1px solid var(--ink-base);
    /* glow extérieur — pas de color-mix, pas de transparent : Safari-safe */
    box-shadow: 0 0 10px var(--ink-glow);
    isolation: isolate; /* nouveau stacking context — fiabilise Safari */
    transition: transform var(--duration-fast) var(--ease-default);
  }
  /* Fill : élément réel (pas ::before) — Safari iOS gère plus fiablement.
     Ancré en bas, hauteur = niveau ; haut plat (l'overflow:hidden du parent
     arrondi clippe le bas en capsule). */
  .ink-pill-fill {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--ink-percent, 0%);
    background-color: var(--ink-base);
    background-image: linear-gradient(to top, var(--ink-base), var(--ink-light));
    z-index: 0;
    transition: height 600ms var(--ease-out);
    pointer-events: none;
  }
  .ink-pill:hover {
    transform: translateY(-1px) scale(1.05);
  }

  .ink-pct {
    font-size: 11px;
    font-weight: 700;
    color: var(--color-fg);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .ink-pct.ink-low {
    color: oklch(0.7 0.19 30);
  }
  .ink-unit {
    font-size: 8px;
    font-weight: 600;
    opacity: 0.7;
    margin-left: 1px;
  }

  .ink-error-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
</style>
