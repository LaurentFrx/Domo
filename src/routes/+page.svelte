<script lang="ts">
  import Header from '$components/layout/Header.svelte';
  import CumulusTile from '$components/tiles/CumulusTile.svelte';
  import ModeSegmentedControl from '$components/tiles/ModeSegmentedControl.svelte';
  import SolarMiniTile from '$components/tiles/SolarMiniTile.svelte';
  import BatteryMiniTile from '$components/tiles/BatteryMiniTile.svelte';
  import ProductionChart from '$components/charts/ProductionChart.svelte';
  import ForecastTile from '$components/tiles/ForecastTile.svelte';
  import { SolcastStore } from '$lib/forecast/solcast.svelte';

  const solcast = new SolcastStore();

  // Refresh au mount uniquement (le throttle 4h évite les hits multiples).
  $effect(() => {
    void solcast.refresh();
  });
</script>

<svelte:head>
  <title>Domo</title>
</svelte:head>

<div class="stagger-enter flex flex-col gap-2 md:gap-3">
  <Header name="Laurent" />

  <!-- Grille principale : 1 col mobile, 2 cols paysage (≥ 768px) -->
  <div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
    <!-- Colonne 1 : Cumulus + mode -->
    <div class="flex flex-col gap-2 md:gap-3">
      <CumulusTile />
      <ModeSegmentedControl />
    </div>

    <!-- Colonne 2 : Solar/Battery + production -->
    <div class="flex flex-col gap-2 md:gap-3">
      <div class="grid grid-cols-2 gap-2">
        <SolarMiniTile />
        <BatteryMiniTile />
      </div>
      <ProductionChart />
    </div>
  </div>

  <ForecastTile {solcast} />
</div>
