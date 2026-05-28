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

  // ─── Strate 2 : Flow Diagram (tout en watts) ─────────────────────────
  const pvPowerW = $derived(Math.round(dashboard.solarPower * 1000));
  const homePowerW = $derived(
    Math.max(0, Math.round(dashboard.solarPower * 1000 + shelly.gridPowerW))
  );
  const batteryNetW = $derived(dashboard.batteryStatus === 'charge' ? 400 : -600);

  // ─── Strate 3 : KPI Cards — totaux jour (info absente du diagramme) ──
  const pvSparkline = $derived(pvSeries24h(dashboard.solarPower * 1.2));
  const consoSparkline = $derived(consoSeries24h());

  // Conso jour estimée = production - export + import (équilibre)
  const consoTodayKwh = $derived(
    dashboard.solarTotal24h - shelly.gridExportTodayKwh + shelly.gridImportTodayKwh
  );
  const savedTodayEuro = $derived(dashboard.solarTotal24h * 0.18);
  const savedMonthEuro = $derived(savedTodayEuro * 30);

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

<div class="stagger-enter flex flex-col gap-4 py-4">
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

  <!-- ═══ Strate 2 : Flow Diagram (280px, tout en watts) ═══ -->
  <FlowDiagram
    {pvPowerW}
    {homePowerW}
    {batteryNetW}
    batterySoc={dashboard.batteryLevel}
    gridPowerW={shelly.gridPowerW}
    cumulusTempC={cumulus.temperatureC}
    cumulusPowerW={shelly.cumulusPowerW}
    cumulusOn={shelly.cumulusRelayOn}
  />

  <!-- ═══ Strate 3 : KPI Cards — totaux jour ═══ -->
  <div class="grid grid-cols-3 gap-3">
    <!-- Production cumulée jour -->
    <KpiCard
      label="Production"
      value={dashboard.solarTotal24h.toFixed(1)}
      unit="kWh"
      trend="aujourd'hui"
      domain="solar"
      sparklineData={pvSparkline}
    />

    <!-- Consommation cumulée jour -->
    <KpiCard
      label="Consommation"
      value={Math.max(0, consoTodayKwh).toFixed(1)}
      unit="kWh"
      trend="aujourd'hui"
      domain="consumption"
      sparklineData={consoSparkline}
    />

    <!-- Économies jour + mois -->
    <KpiCard
      label="Économies"
      value={fmtEuro(savedTodayEuro)}
      trend={`${fmtEuro(savedMonthEuro)} ce mois`}
      domain="hc"
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
