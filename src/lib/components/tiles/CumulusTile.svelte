<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import { formatPower, formatCurrency } from '$utils/format';
  import ModeBadge from '$components/ui/ModeBadge.svelte';
  import Gauge from '$components/ui/Gauge.svelte';
  import StatColumn from '$components/ui/StatColumn.svelte';
</script>

<div
  class="relative overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
>
  <!-- Glow vert décoratif -->
  <div
    class="pointer-events-none absolute h-36 w-36 rounded-full bg-[var(--accent-500)] opacity-10 blur-2xl"
    style="top: -50px; right: -40px;"
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

    <!-- Température + tendance -->
    <div class="flex items-baseline justify-between">
      <div class="flex items-baseline gap-1.5">
        <span class="text-6xl font-light text-white">{dashboard.cumulusTemp}</span>
        <span class="text-2xl font-light text-[var(--text-secondary)]">°C</span>
      </div>
      <div class="flex items-center gap-1 text-xs font-medium text-[var(--accent-500)]">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path
            d="M2 9 L9 2 M9 2 L9 7 M9 2 L4 2"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        +{dashboard.cumulusTempTrend}°C / 1h
      </div>
    </div>

    <!-- Jauge -->
    <Gauge value={dashboard.cumulusGaugePercent} />

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
