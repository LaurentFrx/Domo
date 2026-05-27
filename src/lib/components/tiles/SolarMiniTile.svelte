<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';

  // Mini sparkline décoratif : on échantillonne les 6 dernières valeurs de prod
  const spark = $derived.by(() => {
    const src = dashboard.solarProduction24h.slice(-6);
    if (src.length === 0) return '';
    const max = Math.max(...src, 0.0001);
    const w = 40;
    const h = 12;
    return src
      .map((v, i) => {
        const x = (i * w) / Math.max(1, src.length - 1);
        const y = h - (v / max) * h;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  });
</script>

<div
  class="tile-press flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 shadow-[var(--shadow-card)] md:rounded-2xl md:p-3"
>
  <div class="flex items-center justify-between">
    <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">SOLAIRE</span>
    <svg width="40" height="12" viewBox="0 0 40 12" class="opacity-60">
      <path
        d={spark}
        fill="none"
        stroke="var(--accent-500)"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </div>
  <div class="flex items-baseline gap-1">
    <AnimatedValue
      value={dashboard.solarPower}
      decimals={2}
      class="text-xl font-medium text-[var(--accent-500)] tabular-nums md:text-2xl"
    />
    <span class="text-[10px] text-[var(--text-secondary)] md:text-xs">kW</span>
  </div>
  <span class="text-[10px] text-[var(--text-secondary)]">
    Auto-conso <AnimatedValue value={dashboard.solarSelfConsumption} suffix="%" />
  </span>
</div>
