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
</script>

<div
  class="zigbee-tile relative flex flex-col gap-2 rounded-[var(--radius-xl)] border p-3"
  class:opacity-50={!device.available}
  style="background: var(--color-card); border-color: var(--color-border);"
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

  {#if hasStateControl}
    <button
      type="button"
      class="plug-toggle"
      class:plug-on={isOn}
      role="switch"
      aria-checked={isOn}
      aria-label="Basculer {device.friendlyName}"
      onclick={() => {
        haptic('light');
        zigbee.toggle(device.friendlyName);
      }}
      disabled={!device.available}
    >
      <span class="plug-knob"></span>
    </button>
  {/if}
</div>

<style>
  .plug-toggle {
    position: relative;
    width: 46px;
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
    align-self: flex-start;
  }
  .plug-on {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .plug-toggle:disabled {
    cursor: not-allowed;
  }
  .plug-knob {
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
  .plug-on .plug-knob {
    left: calc(100% - 21px);
  }
</style>
