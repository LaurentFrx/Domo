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

  // ─── Couleurs CMYK base + gradient ───
  const INK_BASE: Record<InkColor, string> = {
    BK: 'oklch(0.30 0.005 280)',
    C: 'oklch(0.70 0.20 220)',
    M: 'oklch(0.62 0.27 350)',
    Y: 'oklch(0.86 0.18 95)'
  };
  const INK_GLOW: Record<InkColor, string> = {
    BK: 'oklch(0.45 0.01 280 / 0.45)',
    C: 'oklch(0.70 0.20 220 / 0.55)',
    M: 'oklch(0.62 0.27 350 / 0.55)',
    Y: 'oklch(0.86 0.18 95 / 0.55)'
  };
  const INK_TEXT_DARK: Record<InkColor, boolean> = {
    BK: false,
    C: false,
    M: false,
    Y: true // jaune trop clair pour texte blanc → texte sombre
  };

  function ratioColor(percent: number): string {
    // Détresse visuelle si < 10 %
    return percent < 10 ? 'var(--color-alert)' : '';
  }

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
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Header : icône + nom + état/conso + toggle -->
  <header class="flex items-center gap-3">
    <span
      class="printer-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn ? 'var(--color-consumption)' : 'var(--color-consumption-muted)'}; color: {isOn ? 'white' : 'var(--color-consumption)'};"
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
      <span class="text-[13px] font-semibold leading-tight" style="color: var(--color-fg);">
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

  <!-- Bandeau pills CMYK : visible dès qu'on a des niveaux, même imprimante éteinte -->
  {#if printer.inks.length > 0}
    <div class="ink-pills flex flex-wrap gap-2">
      {#each printer.inks as ink (ink.color)}
        <div
          class="ink-pill"
          style="
            --ink-base: {INK_BASE[ink.color]};
            --ink-glow: {INK_GLOW[ink.color]};
            color: {INK_TEXT_DARK[ink.color] ? 'oklch(0.20 0 0)' : 'white'};
          "
          title="{ink.label} · {ink.percent}%"
        >
          <span class="ink-pill-label">{ink.label}</span>
          <span class="ink-pill-pct" style:color={ratioColor(ink.percent) || undefined}>
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
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  .printer-tile:hover {
    border-color: var(--color-border-strong);
  }

  .ink-pills {
    /* Distribue les 4 pills équitablement avec une largeur minimum, wrap si besoin */
  }

  .ink-pill {
    flex: 1 1 calc(50% - 0.25rem);
    min-width: 92px;
    display: inline-flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 9999px;
    /* Pill colorée façon "blob" : gradient interne + glow externe + bord soft */
    background: radial-gradient(
        ellipse at 30% 30%,
        color-mix(in oklch, white 25%, var(--ink-base)) 0%,
        var(--ink-base) 70%
      ),
      var(--ink-base);
    box-shadow:
      inset 0 1px 0 color-mix(in oklch, white 30%, transparent),
      inset 0 -1px 1px color-mix(in oklch, black 15%, transparent),
      0 0 14px var(--ink-glow),
      0 0 28px color-mix(in oklch, var(--ink-glow) 50%, transparent);
    transition: transform var(--duration-fast) var(--ease-default);
  }

  .ink-pill:hover {
    transform: translateY(-1px) scale(1.02);
  }

  .ink-pill-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.85;
  }

  .ink-pill-pct {
    font-size: 16px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .ink-pill-unit {
    font-size: 10px;
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
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.2);
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
