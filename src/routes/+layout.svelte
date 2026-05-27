<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';
  import { anker } from '$stores/anker.svelte';
  import { dashboard } from '$stores/dashboard.svelte';

  let { children } = $props();

  // ─── Démo ticker (mock) — actif tant qu'on n'a pas de vraie source ─────
  $effect(() => {
    startDemoTicker();
    return () => stopDemoTicker();
  });

  // ─── Connexion Anker bridge (cloud Solix) ──────────────────────────────
  $effect(() => {
    anker.connect();
    return () => anker.disconnect();
  });

  // ─── Synchro Anker → dashboard quand l'API est dispo ───────────────────
  // Tant que `anker.connected === false`, le demo-ticker continue d'écrire.
  // Dès qu'Anker répond, on bascule connectionStatus='connected' et on
  // écrase les valeurs solaire/batterie du dashboard avec les vraies.
  $effect(() => {
    if (anker.connected) {
      dashboard.connectionStatus = 'connected';
      dashboard.solarPower = anker.solarPowerW / 1000;
      const soc = anker.averageSoc;
      if (soc !== null) dashboard.batteryLevel = soc;
      dashboard.batteryStatus = anker.batteryStatus;
      // Surplus = production - consommation maison (estimée). Si grid est
      // négatif on injecte → c'est le surplus net.
      dashboard.solarSurplus = Math.max(0, -anker.gridPowerW);
      // Production cumulée jour (Wh → kWh).
      dashboard.solarTotal24h = anker.dailyProductionWh / 1000;
      if (anker.selfConsumptionRate !== null) {
        dashboard.solarSelfConsumption = Math.round(anker.selfConsumptionRate);
      }
      if (anker.lastUpdate) dashboard.lastUpdate = anker.lastUpdate;
    } else if (dashboard.connectionStatus === 'connected') {
      // On perd Anker → on rebascule en mode mock pour ne pas figer l'UI.
      dashboard.connectionStatus = 'mock';
    }
  });
</script>

<div class="min-h-screen">
  <Sidebar />

  <main class="safe-top min-h-screen pb-24 md:pb-6 md:pl-20">
    <div class="mx-auto w-full max-w-screen-xl px-3 md:px-6">
      {#key page.url.pathname}
        <div class="animate-[slide-up-fade_0.25s_ease-out]">
          {@render children()}
        </div>
      {/key}
    </div>
  </main>

  <TabBar />
</div>
