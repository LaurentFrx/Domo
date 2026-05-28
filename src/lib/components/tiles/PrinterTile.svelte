<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { printer, type InkColor } from '$stores/printer.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** La prise Zigbee qui alimente l'imprimante (toggle + conso). */
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

  // ─── Couleurs CMYK pour les barres ───
  const INK_COLOR: Record<InkColor, string> = {
    BK: 'oklch(0.20 0 0)', // noir
    C: 'oklch(0.72 0.18 220)', // cyan
    M: 'oklch(0.62 0.27 350)', // magenta
    Y: 'oklch(0.86 0.18 95)' // jaune
  };

  function levelColor(percent: number): string {
    // Si tank très bas (<10%), on bascule en rouge pour l'avertissement
    if (percent < 10) return 'var(--color-alert)';
    return 'var(--color-fg)';
  }
</script>

<article
  class="printer-tile flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
  class:opacity-50={!plug.available}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Header : icône + nom + toggle prise + conso -->
  <header class="flex items-center gap-3">
    <span
      class="printer-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn ? 'var(--color-consumption)' : 'var(--color-consumption-muted)'}; color: {isOn ? 'white' : 'var(--color-consumption)'};"
      aria-hidden="true"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
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
        {plug.model || 'Workforce'}{power !== null && isOn ? ` · ${power.toFixed(0)} W` : ''}
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

  <!-- Séparateur fin -->
  <div class="h-px" style="background: var(--color-border);" aria-hidden="true"></div>

  <!-- Niveaux d'encre -->
  {#if printer.empty && printer.status !== 'connected'}
    <div class="text-[11px]" style="color: var(--color-muted-fg);">
      {#if printer.status === 'unconfigured'}
        Niveaux d'encre indisponibles — `PRINTER_HOST` non configuré dans `.env`.
      {:else if printer.status === 'error'}
        Imprimante injoignable — {printer.lastError ?? 'erreur réseau'}
      {:else}
        Lecture des niveaux d'encre…
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Niveaux d'encre
      </span>
      {#each printer.inks as ink (ink.color)}
        <div class="flex items-center gap-2">
          <span
            class="ink-swatch shrink-0"
            style:background-color={INK_COLOR[ink.color]}
            aria-hidden="true"
          ></span>
          <span class="w-16 shrink-0 text-[11px]" style="color: var(--color-muted-fg);">
            {ink.label}
          </span>
          <div class="ink-track relative flex-1 overflow-hidden rounded-full">
            <div
              class="ink-fill h-full rounded-full"
              style:width="{Math.max(0, Math.min(100, ink.percent))}%"
              style:background-color={INK_COLOR[ink.color]}
            ></div>
          </div>
          <span
            class="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums"
            style:color={levelColor(ink.percent)}
          >
            {ink.percent}%
          </span>
        </div>
      {/each}
    </div>
  {/if}
</article>

<style>
  .printer-tile {
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  .printer-tile:hover {
    border-color: var(--color-border-strong);
  }

  .ink-swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--color-border);
  }
  .ink-track {
    height: 6px;
    background: var(--color-muted);
  }
  .ink-fill {
    transition: width 400ms var(--ease-out);
  }

  /* Toggle (idem SwitchTile) */
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
