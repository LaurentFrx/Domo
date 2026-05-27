<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';

  interface Props {
    device: ZigbeeDevice;
  }

  let { device }: Props = $props();

  const temp = $derived<number | null>(
    typeof device.state.temperature === 'number' ? (device.state.temperature as number) : null
  );
  const humidity = $derived<number | null>(
    typeof device.state.humidity === 'number' ? (device.state.humidity as number) : null
  );
  const battery = $derived<number | null>(
    typeof device.state.battery === 'number' ? (device.state.battery as number) : null
  );
  const link = $derived<number | null>(
    typeof device.state.linkquality === 'number' ? (device.state.linkquality as number) : null
  );

  const batteryColor = $derived(
    battery === null
      ? 'var(--text-tertiary)'
      : battery > 50
        ? 'var(--accent-500)'
        : battery > 20
          ? 'var(--warning)'
          : 'var(--error)'
  );
</script>

<div
  class="tile-press flex flex-col gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 shadow-[var(--shadow-card)] md:rounded-2xl md:p-3"
  class:opacity-50={!device.available}
>
  <div class="flex items-start justify-between gap-2">
    <span class="text-sm leading-tight font-medium text-white">{device.friendlyName}</span>
    <span class="text-[9px] tracking-wider text-[var(--text-tertiary)]">ZB</span>
  </div>

  <div class="flex items-baseline gap-3">
    {#if temp !== null}
      <div class="flex items-baseline gap-0.5">
        <span class="text-xl font-light text-white tabular-nums md:text-2xl">
          {temp.toFixed(1)}
        </span>
        <span class="text-xs text-[var(--text-secondary)]">°C</span>
      </div>
    {/if}
    {#if humidity !== null}
      <div class="flex items-baseline gap-0.5">
        <span class="text-base font-light text-[var(--primary-400)] tabular-nums">
          {Math.round(humidity)}
        </span>
        <span class="text-[10px] text-[var(--text-secondary)]">%</span>
      </div>
    {/if}
  </div>

  <div class="flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
    {#if battery !== null}
      <span class="flex items-center gap-1">
        <span class="h-1 w-1 rounded-full" style:background-color={batteryColor}></span>
        Batt. {Math.round(battery)}%
      </span>
    {:else}
      <span></span>
    {/if}
    {#if link !== null}
      <span class="tabular-nums">LQI {link}</span>
    {/if}
  </div>
</div>
