<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import AreaChart from '$components/charts/AreaChart.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';

  const data = $derived(dashboard.solarProduction24h);
</script>

<div
  class="tile-press flex flex-col gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
>
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]"
      >PRODUCTION 24H</span
    >
    <span class="text-xs font-medium text-[var(--accent-500)]">
      +<AnimatedValue value={dashboard.solarTotal24h} decimals={1} /> kWh
    </span>
  </div>

  <AreaChart {data} color="var(--accent-500)" height={80} />

  <div class="flex justify-between text-[9px] text-[var(--text-secondary)]">
    <span>06h</span>
    <span>09h</span>
    <span>12h</span>
    <span>15h</span>
    <span>18h</span>
  </div>
</div>
