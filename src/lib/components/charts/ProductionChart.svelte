<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';

  const bars = $derived(dashboard.solarProduction24h);
  const maxBarHeight = 50;

  function barOpacity(value: number): number {
    return value < 0.3 ? 0.3 + value : 1.0;
  }
</script>

<div
  class="flex flex-col gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
>
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]"
      >PRODUCTION 24H</span
    >
    <span class="text-xs font-medium text-[var(--accent-500)]">+{dashboard.solarTotal24h} kWh</span>
  </div>

  <div class="flex items-end gap-1" style="height: {maxBarHeight}px;">
    {#each bars as v, i (i)}
      <div
        class="flex-1 rounded-full"
        style="
          background-color: var(--accent-500);
          opacity: {barOpacity(v)};
          height: {Math.max(4, v * maxBarHeight)}px;
        "
      ></div>
    {/each}
  </div>

  <div class="flex justify-between text-[9px] text-[var(--text-secondary)]">
    <span>06h</span>
    <span>12h</span>
    <span>18h</span>
  </div>
</div>
