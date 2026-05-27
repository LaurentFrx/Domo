<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import { formatPower, formatCurrency } from '$utils/format';
  import { modeColor } from '$theme/tokens';
  import ModeBadge from '$components/ui/ModeBadge.svelte';
  import ArcGauge from '$components/ui/ArcGauge.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';
  import StatColumn from '$components/ui/StatColumn.svelte';

  const accent = $derived(modeColor(dashboard.cumulusMode));
</script>

<div
  class="tile-press relative overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
>
  <!-- Glow décoratif suivant le mode -->
  <div
    class="glow-animated pointer-events-none absolute h-36 w-36 rounded-full blur-2xl"
    style="top: -50px; right: -40px; background-color: {accent};"
  ></div>

  <div class="relative flex flex-col gap-4">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div class="flex flex-col">
        <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
          CUMULUS 3000W
        </span>
        <span class="text-xs text-white/60">Garage</span>
      </div>
      <ModeBadge mode={dashboard.cumulusMode} />
    </div>

    <!-- Température + ArcGauge -->
    <div class="flex items-center justify-between gap-4">
      <div class="flex flex-col">
        <div class="flex items-baseline gap-1.5">
          <AnimatedValue
            value={dashboard.cumulusTemp}
            decimals={1}
            class="text-6xl font-light text-white tabular-nums"
          />
          <span class="text-2xl font-light text-[var(--text-secondary)]">°C</span>
        </div>
        <div class="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--accent-500)]">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
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

      <ArcGauge value={dashboard.cumulusGaugePercent} size={88} strokeWidth={5} color={accent} />
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
