<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    device: ZigbeeDevice;
  }

  let { device }: Props = $props();

  const isOn = $derived(device.state.state === 'ON');
  const power = $derived<number | null>(
    Number.isFinite(device.state.power) ? (device.state.power as number) : null
  );
  const energy = $derived<number | null>(
    Number.isFinite(device.state.energy) ? (device.state.energy as number) : null
  );
  const hasStateControl = $derived(typeof device.state.state === 'string');

  function onToggle() {
    if (!device.available || !hasStateControl) return;
    haptic('light');
    zigbee.toggle(device.friendlyName);
  }
</script>

<!-- Toute la carte fait office d'interrupteur quand le device est pilotable
     (plus de toggle séparé : la carte EST le bouton). Sinon, simple tuile de
     mesure (div non interactif). -->
<svelte:element
  this={hasStateControl ? 'button' : 'div'}
  type={hasStateControl ? 'button' : undefined}
  class="zigbee-tile flex w-full flex-col gap-2 rounded-[var(--radius-xl)] border p-3 text-left"
  class:opacity-50={!device.available}
  class:plug-lit={isOn && hasStateControl}
  style="background: var(--color-card); border-color: var(--color-border); --neon: var(--color-primary);"
  role={hasStateControl ? 'switch' : undefined}
  aria-checked={hasStateControl ? isOn : undefined}
  aria-label={hasStateControl ? `Basculer ${device.friendlyName}` : undefined}
  disabled={hasStateControl ? !device.available : undefined}
  onclick={hasStateControl ? onToggle : undefined}
>
  <div class="flex items-start justify-between gap-2">
    <div class="flex min-w-0 flex-col gap-0.5">
      <span
        class="truncate text-[12px] leading-tight font-semibold"
        style="color: var(--color-fg);"
      >
        {device.friendlyName}
      </span>
      <span class="text-[10px]" style="color: var(--color-muted-fg);">
        {device.model}
      </span>
    </div>
    {#if hasStateControl}
      <span
        class="shrink-0 text-[10px] font-semibold tracking-[0.04em] uppercase"
        style:color={isOn ? 'var(--color-primary)' : 'var(--color-muted-fg)'}
      >
        {isOn ? 'On' : 'Off'}
      </span>
    {/if}
  </div>

  {#if power !== null}
    <div class="flex items-baseline gap-1">
      <span
        class="text-[20px] leading-none font-bold tabular-nums"
        style:color={power > 5 ? 'var(--color-consumption)' : 'var(--color-muted-fg)'}
        style:letter-spacing="-0.01em"
      >
        {power.toFixed(power < 10 ? 1 : 0)}
      </span>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">W</span>
      {#if energy !== null}
        <span class="ml-auto text-[10px] tabular-nums" style="color: var(--color-muted-fg);">
          {energy.toFixed(1)} kWh
        </span>
      {/if}
    </div>
  {/if}
</svelte:element>

<style>
  .zigbee-tile {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .zigbee-tile[role='switch'] {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .zigbee-tile[role='switch']:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .zigbee-tile[role='switch']:active:not(:disabled) {
    transform: scale(0.99);
  }
  .zigbee-tile[role='switch']:disabled {
    cursor: not-allowed;
  }
  .zigbee-tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* Allumée : bord néon + halo (toutes tailles) → état visible sans toggle.
     Halos en tokens pré-calculés (jamais color-mix en box-shadow : piège Chrome). */
  .zigbee-tile.plug-lit {
    border-color: var(--neon);
    box-shadow:
      0 0 0 1px var(--color-primary-glow-mid),
      0 6px 16px -6px var(--color-primary-glow-mid);
  }
  /* iPhone : relief coloré + léger fond teinté (mesures W / kWh restent lisibles). */
  @media (max-width: 639px) {
    .zigbee-tile.plug-lit {
      background-image: linear-gradient(
        135deg,
        color-mix(in oklch, var(--neon) 16%, transparent),
        transparent 60%
      ) !important;
      box-shadow:
        inset 0 1px 0.5px oklch(1 0 0 / 0.4),
        0 6px 16px -4px var(--color-primary-glow),
        0 0 0 1px var(--color-primary-glow-mid);
    }
  }
</style>
