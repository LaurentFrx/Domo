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
      ? 'var(--color-muted-fg)'
      : battery > 50
        ? 'var(--color-battery)'
        : battery > 20
          ? 'var(--color-warning)'
          : 'var(--color-alert)'
  );
</script>

<div
  class="flex flex-col gap-1.5 rounded-[var(--radius-xl)] border p-3"
  class:opacity-50={!device.available}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex items-start justify-between gap-2">
    <span
      class="text-[12px] font-semibold leading-tight truncate"
      style="color: var(--color-fg);"
    >
      {device.friendlyName}
    </span>
    <span
      class="shrink-0 text-[9px] font-semibold tracking-[0.04em]"
      style="color: var(--color-muted-fg);"
    >
      ZB
    </span>
  </div>

  <div class="flex items-baseline gap-3">
    {#if temp !== null}
      <div class="flex items-baseline gap-0.5">
        <span
          class="text-[22px] font-bold tabular-nums leading-none"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
          {temp.toFixed(1)}
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">°C</span>
      </div>
    {/if}
    {#if humidity !== null}
      <div class="flex items-baseline gap-0.5">
        <span
          class="text-[15px] font-semibold tabular-nums"
          style="color: var(--color-consumption);"
        >
          {Math.round(humidity)}
        </span>
        <span class="text-[10px]" style="color: var(--color-muted-fg);">%</span>
      </div>
    {/if}
  </div>

  <div
    class="flex items-center justify-between text-[10px]"
    style="color: var(--color-muted-fg);"
  >
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
