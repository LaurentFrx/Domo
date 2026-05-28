<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';
  import { anker } from '$stores/anker.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { preferences } from '$stores/preferences.svelte';

  let { children } = $props();

  // ─── Hydrater les préférences (theme, animations…) global, dès le mount ─
  // Sans ça, un reload sur n'importe quelle page autre que /reglages
  // perd le theme dark.
  $effect(() => {
    preferences.hydrate();
  });

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
  $effect(() => {
    if (anker.connected) {
      dashboard.connectionStatus = 'connected';
      dashboard.solarPower = anker.solarPowerW / 1000;
      const soc = anker.averageSoc;
      if (soc !== null) dashboard.batteryLevel = soc;
      dashboard.batteryStatus = anker.batteryStatus;
      dashboard.solarSurplus = Math.max(0, -anker.gridPowerW);
      dashboard.solarTotal24h = anker.dailyProductionWh / 1000;
      if (anker.selfConsumptionRate !== null) {
        dashboard.solarSelfConsumption = Math.round(anker.selfConsumptionRate);
      }
      if (anker.lastUpdate) dashboard.lastUpdate = anker.lastUpdate;
    } else if (dashboard.connectionStatus === 'connected') {
      dashboard.connectionStatus = 'mock';
    }
  });
</script>

<div class="min-h-screen" style="background: var(--color-bg); color: var(--color-fg);">
  <Sidebar />

  <main
    class="safe-top min-h-screen sm:pl-[72px] lg:pl-[280px]"
    style="padding-bottom: calc(60px + env(safe-area-inset-bottom));"
  >
    <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
      {#key page.url.pathname}
        <div class="animate-[slide-up-fade_0.25s_var(--ease-out)]">
          {@render children()}
        </div>
      {/key}
    </div>
  </main>

  <TabBar />
</div>

<style>
  /* Compense le padding-bottom sur les écrans sm+ (tab bar masquée) */
  @media (min-width: 640px) {
    main {
      padding-bottom: 0 !important;
    }
  }
</style>
