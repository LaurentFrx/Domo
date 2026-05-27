<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import AreaChart from '$components/charts/AreaChart.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';

  let innerWidth = $state(0);
  const chartHeight = $derived(innerWidth >= 768 ? 60 : 48);

  const data = $derived(dashboard.solarProduction24h);
</script>

<svelte:window bind:innerWidth />

<div
  class="tile-press flex flex-col gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 shadow-[var(--shadow-card)] md:gap-2 md:rounded-2xl md:p-3"
>
  <div class="flex items-center justify-between">
    <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
      >PRODUCTION 24H</span
    >
    <span class="text-[10px] font-medium text-[var(--accent-500)] md:text-xs">
      +<AnimatedValue value={dashboard.solarTotal24h} decimals={1} /> kWh
    </span>
  </div>

  <AreaChart {data} color="var(--accent-500)" height={chartHeight} />

  <div class="flex justify-between text-[9px] text-[var(--text-secondary)]">
    <span>06h</span>
    <span>09h</span>
    <span>12h</span>
    <span>15h</span>
    <span>18h</span>
  </div>
</div>
