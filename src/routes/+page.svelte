<script lang="ts">
  import Header from '$components/layout/Header.svelte';
  import CumulusTile from '$components/tiles/CumulusTile.svelte';
  import ModeSegmentedControl from '$components/tiles/ModeSegmentedControl.svelte';
  import SolarMiniTile from '$components/tiles/SolarMiniTile.svelte';
  import BatteryMiniTile from '$components/tiles/BatteryMiniTile.svelte';
  import ProductionChart from '$components/charts/ProductionChart.svelte';
  import ForecastTile from '$components/tiles/ForecastTile.svelte';
  import VoletsSummaryTile from '$components/tiles/VoletsSummaryTile.svelte';
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

<div class="flex flex-col gap-3 pb-6">
  <Header name="Laurent" />
  <CumulusTile />
  <ModeSegmentedControl />
  <div class="grid grid-cols-2 gap-2">
    <SolarMiniTile />
    <BatteryMiniTile />
  </div>
  <ProductionChart />
  <VoletsSummaryTile />
  <ForecastTile {solcast} />
</div>
