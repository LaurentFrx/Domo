<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import PullToRefresh from '$components/layout/PullToRefresh.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';
  import { anker } from '$stores/anker.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { settings } from '$stores/settings.svelte';
  import { haptic } from '$utils/haptic';

  let { children } = $props();

  // ─── Retour haptique GLOBAL ────────────────────────────────────────────
  // Un seul écouteur délégué : tout bouton (ou contrôle interactif) activé dans
  // l'app vibre, sans câbler haptic() partout. Les handlers qui appellent déjà
  // haptic() avec une intensité précise ne double-buzzent pas (garde anti-rebond
  // dans l'utilitaire). Opt-out via [data-no-haptic]. On écoute pointerdown pour
  // un retour synchrone du geste (et non au click, plus tardif).
  function onRootPointerDown(ev: PointerEvent) {
    const el = ev.target as Element | null;
    const hit = el?.closest?.(
      'button, [role="button"], [role="switch"], [role="slider"], a[href], summary'
    );
    if (!hit) return;
    if (hit.closest('[data-no-haptic]')) return;
    if (hit.hasAttribute('disabled') || hit.getAttribute('aria-disabled') === 'true') return;
    haptic('light');
  }

  // ─── Hydrater les préférences (theme, animations…) global, dès le mount ─
  // Sans ça, un reload sur n'importe quelle page autre que /reglages
  // perd le theme dark.
  $effect(() => {
    preferences.hydrate();
  });

  // ─── Réglages métier (prix, coût/date installation, facteur CO2) app-wide ──
  // Hydratés ici pour que l'accueil (CO2 évité) et l'énergie (ROI) y aient accès.
  $effect(() => {
    settings.hydrate();
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

  // ─── Connexion APsystems (onduleur EZ1, bridge local) ──────────────────
  // App-wide : la production APS doit entrer dans le bilan de l'ACCUEIL (Sankey,
  // « Solaire »), pas seulement sur la page Énergie. Poll 10 s, visibility-aware,
  // connect() idempotent → un seul polling même si une page la rappelle.
  $effect(() => {
    apsystems.connect();
    return () => apsystems.disconnect();
  });

  // ─── Économies d'autoconsommation (route locale, base recorder) ────────
  // App-wide : carte affichée sur Accueil + Énergie. Poll 60 s, visibility-aware.
  $effect(() => {
    savings.connect();
    return () => savings.disconnect();
  });

  // ─── Tarif HP/HC RÉEL (route serveur, vraie fenêtre HC) ────────────────
  $effect(() => {
    tariff.connect();
    return () => tariff.disconnect();
  });

  // ─── Synchro Anker → dashboard quand l'API est dispo ───────────────────
  $effect(() => {
    if (anker.connected) {
      dashboard.connectionStatus = 'connected';
      // Production = SolarBank (solar_power_w, cohérent avec l'app Anker) + APS EZ1.
      dashboard.solarPower = (anker.solarPowerW + production.apsW) / 1000;
      const soc = anker.averageSoc;
      if (soc !== null) dashboard.batteryLevel = soc;
      dashboard.batteryStatus = anker.batteryStatus;
      // Surplus = injection réseau, depuis le réseau FIABLE dérivé du Linky (le brut
      // instantané du cloud est figé/fantôme → faux surplus). Cf. anker.gridReliableW.
      dashboard.solarSurplus = Math.max(0, -anker.gridReliableW);
      // Compteur jour du bridge parfois figé (≈ lifetime) → on n'écrase que si fiable.
      if (anker.dailyProductionReliable) dashboard.solarTotal24h = anker.dailyProductionWh / 1000;
      if (anker.selfConsumptionRate !== null) {
        dashboard.solarSelfConsumption = Math.round(anker.selfConsumptionRate);
      }
      if (anker.lastUpdate) dashboard.lastUpdate = anker.lastUpdate;
    } else if (dashboard.connectionStatus === 'connected') {
      dashboard.connectionStatus = 'mock';
    }
  });
</script>

<!-- Écouteur de délégation PASSIF : déclenche seulement le retour haptique ; les
     vraies interactions restent sur les boutons enfants (qui ont leur rôle). Un
     role ARIA ici serait trompeur → on désactive la règle a11y pour ce nœud. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="min-h-screen"
  style="background: var(--color-bg); color: var(--color-fg);"
  onpointerdown={onRootPointerDown}
>
  <!-- Calque d'ambiance (halos verts/indigo) : matière pour le verre + profondeur -->
  <div class="app-ambient" aria-hidden="true"></div>

  <!-- Tirer-pour-rafraîchir (geste tactile en haut de page) -->
  <PullToRefresh />

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
