<script lang="ts">
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { shelly } from '$stores/shelly.svelte';
  import {
    hourOfDay,
    tariffMode,
    tariffPrice,
    pvSeries24h,
    consoSeries24h
  } from '$utils/mock-curves';

  // ─── Strate 1 : Hero KPI auto-conso ─────────────────────────────────
  const autoConso = $derived(dashboard.solarSelfConsumption);
  const netSurplus = $derived(dashboard.solarSurplus);
  const isExporting = $derived(shelly.gridPowerW < 0);

  // ─── Strate 2 : Flow Diagram ────────────────────────────────────────
  const homePowerKw = $derived(
    Math.max(0, dashboard.solarPower + shelly.gridPowerW / 1000 - 0)
  );
  const batteryNetKw = $derived(dashboard.batteryStatus === 'charge' ? 0.4 : -0.6);

  // ─── Strate 3 : KPI Cards ───────────────────────────────────────────
  const pvSparkline = $derived(pvSeries24h(dashboard.solarPower * 1.2));
  const consoSparkline = $derived(consoSeries24h());
  const cumulusSparkline = $derived([55, 56, 57, 58, 60, 62, 63, 64, 64, 65, 65, 64]);
  const batterySparkline = $derived([55, 58, 62, 68, 75, 82, 87, 89, 90, 88, 85, 80]);

  // ─── Strate 4 : Footer ──────────────────────────────────────────────
  const hour = $derived(hourOfDay());
  const currentTariff = $derived(tariffMode(hour));
  const currentPrice = $derived(tariffPrice(hour));
  const nextTariffSwitch = $derived(currentTariff === 'HC' ? '6h' : '22h');

  function fmtEuro(n: number): string {
    return n.toFixed(2).replace('.', ',') + ' €';
  }
</script>

<svelte:head>
  <title>Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 py-4">
  <!-- ═══ Strate 1 : Hero KPI (~80px) ═══ -->
  <header class="flex items-center justify-between gap-4">
    <div class="flex flex-col gap-0.5">
      <div class="flex items-baseline gap-2">
        <span
          class="text-[40px] font-bold leading-none tracking-tight sm:text-[44px]"
          style="color: var(--color-fg); letter-spacing: -0.02em;"
        >
          {autoConso}<span class="text-[24px] font-semibold" style="color: var(--color-muted-fg);">%</span>
        </span>
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          autoconso
        </span>
      </div>
      <span
        class="text-[13px] font-medium"
        style="color: {isExporting ? 'var(--color-solar)' : 'var(--color-muted-fg)'};"
      >
        {isExporting ? '↑' : '↓'} {Math.abs(netSurplus)} W {isExporting ? 'injection' : 'import réseau'}
      </span>
    </div>

    <span
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase"
      style="background: var(--color-battery-muted); color: var(--color-battery);"
    >
      <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-battery);"></span>
      Tout fonctionne
    </span>
  </header>

  <!-- ═══ Strate 2 : Flow Diagram (240px) ═══ -->
  <FlowDiagram
    pvPowerKw={dashboard.solarPower}
    {homePowerKw}
    {batteryNetKw}
    batterySoc={dashboard.batteryLevel}
    gridPowerKw={shelly.gridPowerW / 1000}
    cumulusTempC={cumulus.temperatureC}
    cumulusOn={shelly.cumulusRelayOn}
  />

  <!-- ═══ Strate 3 : KPI Cards ═══ -->
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <!-- Cumulus -->
    <KpiCard
      label="Cumulus"
      value={cumulus.temperatureC.toFixed(0)}
      unit="°C"
      trend={`${cumulus.trendCh >= 0 ? '↑' : '↓'} ${Math.abs(cumulus.trendCh).toFixed(1)} °C/h`}
      badge={cumulus.currentMode}
      domain="hc"
      badgeDomain={cumulus.currentMode === 'PV' ? 'solar' : cumulus.currentMode === 'HC' ? 'hc' : cumulus.currentMode === 'FORCE' ? 'alert' : 'grid'}
      sparklineData={cumulusSparkline}
    />

    <!-- Batterie -->
    <KpiCard
      label="Batterie"
      value={dashboard.batteryLevel.toFixed(0)}
      unit="%"
      trend={dashboard.batteryStatus === 'charge' ? '↑ Charge' : dashboard.batteryStatus === 'discharge' ? '↓ Décharge' : 'Repos'}
      domain="battery"
      sparklineData={batterySparkline}
    />

    <!-- Production PV -->
    <KpiCard
      label="Production"
      value={dashboard.solarPower.toFixed(2)}
      unit="kW"
      trend={`${dashboard.solarTotal24h.toFixed(1)} kWh aujourd'hui`}
      domain="solar"
      sparklineData={pvSparkline}
    />

    <!-- Économies -->
    <KpiCard
      label="Économies"
      value={fmtEuro(dashboard.solarTotal24h * 0.18)}
      trend={`${fmtEuro(dashboard.solarTotal24h * 0.18 * 30)} ce mois`}
      domain="hc"
      sparklineData={consoSparkline}
    />
  </div>

  <!-- ═══ Strate 4 : Footer KPIs ═══ -->
  <footer
    class="flex items-center justify-between gap-3 rounded-[var(--radius-xl)] border px-4 py-3 text-[12px]"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex flex-col gap-0.5">
      <span class="font-semibold tracking-[0.04em] uppercase" style="color: var(--color-muted-fg); font-size: 10px;">
        Réseau
      </span>
      <span style="color: var(--color-fg);">
        ↓ {shelly.gridImportTodayKwh.toFixed(1)} · ↑ {shelly.gridExportTodayKwh.toFixed(1)} kWh
      </span>
    </div>

    <div class="flex flex-col items-center gap-0.5">
      <span class="font-semibold tracking-[0.04em] uppercase" style="color: var(--color-muted-fg); font-size: 10px;">
        Tarif
      </span>
      <span
        class="font-semibold"
        style="color: {currentTariff === 'HC' ? 'var(--color-hc)' : 'var(--color-hp)'};"
      >
        {currentTariff} · {(currentPrice * 100).toFixed(2)} cts/kWh
      </span>
    </div>

    <div class="flex flex-col items-end gap-0.5">
      <span class="font-semibold tracking-[0.04em] uppercase" style="color: var(--color-muted-fg); font-size: 10px;">
        Bascule
      </span>
      <span style="color: var(--color-fg);">
        dans {nextTariffSwitch}
      </span>
    </div>
  </footer>
</div>
