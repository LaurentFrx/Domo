<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import { formatPower, formatCurrency } from '$utils/format';
  import { modeColor } from '$theme/tokens';
  import ModeBadge from '$components/ui/ModeBadge.svelte';
  import ArcGauge from '$components/ui/ArcGauge.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';
  import StatColumn from '$components/ui/StatColumn.svelte';

  let innerWidth = $state(0);
  const gaugeSize = $derived(innerWidth >= 768 ? 88 : 72);

  const accent = $derived(modeColor(dashboard.cumulusMode));
</script>

<svelte:window bind:innerWidth />

<div
  class="tile-press relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
>
  <!-- Glow décoratif suivant le mode -->
  <div
    class="glow-animated pointer-events-none absolute h-24 w-24 rounded-full blur-2xl md:h-32 md:w-32"
    style="top: -40px; right: -32px; background-color: {accent};"
  ></div>

  <div class="relative flex flex-col gap-2 md:gap-3">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div class="flex flex-col">
        <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
          CUMULUS 3000W
        </span>
        <span class="text-[10px] text-white/60">Garage</span>
      </div>
      <ModeBadge mode={dashboard.cumulusMode} />
    </div>

    <!-- Température + ArcGauge -->
    <div class="flex items-center justify-between gap-3">
      <div class="flex flex-col">
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={dashboard.cumulusTemp}
            decimals={1}
            class="text-4xl font-light text-white tabular-nums md:text-5xl"
          />
          <span class="text-xl font-light text-[var(--text-secondary)] md:text-2xl">°C</span>
        </div>
        <div
          class="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-[var(--accent-500)] md:text-xs"
        >
          <svg width="10" height="10" viewBox="0 0 11 11" fill="none">
            <path
              d="M2 9 L9 2 M9 2 L9 7 M9 2 L4 2"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          <AnimatedValue
            value={dashboard.cumulusTempTrend}
            decimals={1}
            prefix="+"
            suffix="°C / 1h"
          />
        </div>
      </div>

      <ArcGauge
        value={dashboard.cumulusGaugePercent}
        size={gaugeSize}
        strokeWidth={5}
        color={accent}
      />
    </div>

    <!-- Séparateur -->
    <div class="h-px w-full bg-white/[0.08]"></div>

    <!-- 3 stats -->
    <div class="flex justify-between">
      <StatColumn label="Puissance" value={formatPower(dashboard.cumulusPower)} />
      <StatColumn
        label="Surplus PV"
        value="+{formatPower(dashboard.solarSurplus)}"
        color="var(--accent-500)"
      />
      <StatColumn label="Coût h." value={formatCurrency(dashboard.cumulusCostHour)} />
    </div>
  </div>
</div>
