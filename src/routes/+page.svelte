<script lang="ts">
  import FlowDiagram from '$components/charts/FlowDiagram.svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import { anker } from '$stores/anker.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { shelly } from '$stores/shelly.svelte';
  import { hourOfDay, tariffMode, tariffPrice } from '$utils/mock-curves';

  // ─── Source canonique : Anker quand connecté, mock sinon ─────────────
  // Tout en watts, signed (+ import / − export).
  const pvPowerW = $derived(
    anker.connected ? anker.solarPowerW : Math.round(dashboard.solarPower * 1000)
  );
  const gridPowerW = $derived(anker.connected ? anker.gridPowerW : shelly.gridPowerW);
  const batterySoc = $derived(anker.connected ? (anker.averageSoc ?? 0) : dashboard.batteryLevel);
  const batteryNetW = $derived(
    anker.connected ? anker.netBatteryPowerW : dashboard.batteryStatus === 'charge' ? 400 : -600
  );

  // Maison = PV + import réseau − charge batterie (équilibre énergétique
  // instantané — on ignore les pertes de conversion < 5%)
  const homePowerW = $derived(Math.max(0, Math.round(pvPowerW + gridPowerW - batteryNetW)));

  // ─── Hero : auto-conso + flux net ─────────────────────────────────────
  const autoConso = $derived(
    anker.connected ? Math.round(anker.selfConsumptionRate ?? 0) : dashboard.solarSelfConsumption
  );
  const isExporting = $derived(gridPowerW < -5);
  const isImporting = $derived(gridPowerW > 5);

  // ─── 3 cards lifetime (depuis Anker, vraies données) ─────────────────
  const hasLifetime = $derived(anker.connected && anker.lifetimeProductionKwh > 0);

  function fmtNumber(n: number, decimals = 0): string {
    return n.toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }
  function fmtEuro(n: number): string {
    return fmtNumber(n, 0) + ' €';
  }
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }

  // ─── Footer : tarif courant + prochaine bascule ──────────────────────
  const hour = $derived(hourOfDay());
  const currentTariff = $derived(tariffMode(hour));
  const currentPrice = $derived(tariffPrice(hour));
  const nextSwitchHour = $derived(currentTariff === 'HC' ? 6 : 22);
  const hoursUntilSwitch = $derived(
    nextSwitchHour > hour ? Math.ceil(nextSwitchHour - hour) : Math.ceil(24 - hour + nextSwitchHour)
  );
</script>

<svelte:head>
  <title>Domo</title>
</svelte:head>

<div class="stagger-enter flex flex-col gap-5 py-4">
  <!-- ═══ Hero — Auto-consommation ═══ -->
  <header class="flex items-center justify-between gap-4">
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline gap-2">
        <span
          class="text-[40px] leading-none font-bold tracking-tight sm:text-[48px]"
          style="color: var(--color-fg); letter-spacing: -0.02em;"
        >
          {autoConso}<span class="text-[24px] font-semibold" style="color: var(--color-muted-fg);"
            >%</span
          >
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
        style="color: {isExporting
          ? 'var(--color-solar)'
          : isImporting
            ? 'var(--color-grid-energy)'
            : 'var(--color-muted-fg)'};"
      >
        {#if isExporting}
          ↑ {fmtW(gridPowerW)} W injectés sur le réseau
        {:else if isImporting}
          ↓ {fmtW(gridPowerW)} W soutirés du réseau
        {:else}
          Réseau à l'équilibre
        {/if}
      </span>
    </div>

    <span
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase"
      style="background: {anker.connected
        ? 'var(--color-battery-muted)'
        : 'var(--color-warning) / 0.15'}; color: {anker.connected
        ? 'var(--color-battery)'
        : 'var(--color-warning)'};"
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style="background: {anker.connected ? 'var(--color-battery)' : 'var(--color-warning)'};"
      ></span>
      {anker.connected ? 'Anker connecté' : 'Mode démo'}
    </span>
  </header>

  <!-- ═══ Flow Diagram (carré centré, max 520px) ═══ -->
  <FlowDiagram
    {pvPowerW}
    {homePowerW}
    {batteryNetW}
    {batterySoc}
    {gridPowerW}
    cumulusTempC={cumulus.temperatureC}
    cumulusPowerW={shelly.cumulusPowerW}
    cumulusOn={shelly.cumulusRelayOn}
  />

  <!-- ═══ KPI lifetime (vraies données Anker) ═══ -->
  {#if hasLifetime}
    <div class="grid grid-cols-3 gap-3">
      <KpiCard
        label="Production totale"
        value={fmtNumber(anker.lifetimeProductionKwh, 0)}
        unit="kWh"
        trend="depuis l'installation"
        domain="solar"
      />
      <KpiCard
        label="CO₂ évité"
        value={fmtNumber(anker.lifetimeCo2SavedKg, 0)}
        unit="kg"
        trend={`≈ ${fmtNumber(anker.lifetimeCo2SavedKg * 6, 0)} km en VE`}
        domain="battery"
      />
      <KpiCard
        label="Économies"
        value={fmtEuro(anker.lifetimeSavingsEur)}
        trend="depuis l'installation"
        domain="hc"
      />
    </div>
  {:else}
    <!-- Anker pas connecté : carte unique d'état -->
    <div
      class="rounded-[var(--radius-xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Statistiques
      </span>
      <p class="mt-1 text-[13px]" style="color: var(--color-muted-fg);">
        En attente du bridge Anker pour les compteurs historiques.
      </p>
    </div>
  {/if}

  <!-- ═══ Footer — Tarif & bascule ═══ -->
  <footer
    class="grid grid-cols-3 items-center gap-3 rounded-[var(--radius-xl)] border px-4 py-3"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex flex-col gap-0.5">
      <span
        class="font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg); font-size: 10px;"
      >
        Tarif en cours
      </span>
      <span
        class="text-[14px] font-semibold tabular-nums"
        style="color: {currentTariff === 'HC' ? 'var(--color-hc)' : 'var(--color-hp)'};"
      >
        {currentTariff} · {(currentPrice * 100).toFixed(2)} cts/kWh
      </span>
    </div>

    <div class="flex flex-col items-center gap-0.5">
      <span
        class="font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg); font-size: 10px;"
      >
        Réseau aujourd'hui
      </span>
      <span class="text-[14px] tabular-nums" style="color: var(--color-fg);">
        ↓ {shelly.gridImportTodayKwh.toFixed(1)} · ↑ {shelly.gridExportTodayKwh.toFixed(1)} kWh
      </span>
    </div>

    <div class="flex flex-col items-end gap-0.5">
      <span
        class="font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg); font-size: 10px;"
      >
        Bascule
      </span>
      <span class="text-[14px] tabular-nums" style="color: var(--color-fg);">
        {currentTariff === 'HC' ? 'HP' : 'HC'} à {nextSwitchHour}h · dans {hoursUntilSwitch} h
      </span>
    </div>
  </footer>
</div>
