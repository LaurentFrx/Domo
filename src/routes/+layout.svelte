<script lang="ts">
  import '../app.css';
  import { page, updated } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { navItems, isActive } from '$components/layout/nav-items';
  import { onMount } from 'svelte';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import PullToRefresh from '$components/layout/PullToRefresh.svelte';
  import HealthBanner from '$components/layout/HealthBanner.svelte';
  import Pager from '$lib/pager/Pager.svelte';
  import { startDemoTicker, stopDemoTicker } from '$stores/demo-ticker.svelte';
  import { anker } from '$stores/anker.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { production } from '$stores/production.svelte';
  import { savings } from '$stores/savings.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { dashboard } from '$stores/dashboard.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { settings } from '$stores/settings.svelte';
  import { health } from '$stores/health.svelte';
  import { haptic } from '$utils/haptic';

  let { children } = $props();

  // ─── Page active (pour le <title> centralisé) ─────────────────────────
  const curIdx = $derived(navItems.findIndex((it) => isActive(page.url.pathname, it.href)));

  // ─── Pager (rail unifié, physique de ressort) ─────────────────────────
  // Rendu CÔTÉ CLIENT après hydratation : SSR + 1er paint = la page du routeur
  // (children) ; puis le Pager prend la main (rail keyé par href, ressort seedé par
  // la vitesse du doigt, commit par pushState → zéro re-montage). Cf. src/lib/pager/.
  let pagerReady = $state(false);
  onMount(() => {
    pagerReady = true;
  });

  // ─── Auto-reload après déploiement (anti « client périmé ») ─────────────
  // À chaque déploiement, les chunks JS changent de hash : un onglet/PWA déjà
  // ouvert garde d'anciennes références → une navigation client échoue à charger
  // les modules et l'app « ne répond plus ». `version.pollInterval` (svelte.config)
  // détecte la nouvelle version (`updated.current`) ; on force alors une navigation
  // PLEINE page (location.href) qui recharge le code à jour. Filet durable.
  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && to?.url && !willUnload) {
      location.href = to.url.href;
    }
  });

  // ─── Boutons « façon iOS » : pression visuelle + haptique de CONFIRMATION ──
  // Un seul gestionnaire délégué reproduit le bouton natif iOS, sans câbler
  // chaque composant :
  //  • TOUCHER (pointerdown) : l'élément s'enfonce (data-pressed → scale en CSS).
  //    Aucune action.
  //  • GLISSÉ hors de l'élément / scroll (pointermove sortant, pointercancel) :
  //    on relâche la pression — l'action sera annulée (= touchDragExit natif).
  //  • RELÂCHÉ sur l'élément : le navigateur émet `click` (= touchUpInside) → on
  //    déclenche le retour haptique de confirmation, puis l'action du composant
  //    s'exécute. PAS de délai artificiel : la latence perçue = toucher→relâché.
  // Haptique sur `click` (et non pointerdown) : ça arrive AU moment de l'action,
  // et les intensités spécifiques (haptic('success') d'un on/off…) gagnent le
  // dédoublonnage sur le 'light' global au lieu d'être masquées. Opt-out
  // haptique via [data-no-haptic]. Enfoncement visuel : boutons/liens seulement
  // (un switch/slider ne « s'enfonce » pas).
  const PRESS_VISUAL = 'button, [role="button"], a[href], summary';
  const HAPTIC_TARGET =
    'button, [role="button"], [role="switch"], [role="slider"], a[href], summary';
  let pressedEl: HTMLElement | null = null;
  let pressRect: DOMRect | null = null;

  function releasePress() {
    pressedEl?.removeAttribute('data-pressed');
    pressedEl = null;
    pressRect = null;
  }
  function onRootPointerDown(ev: PointerEvent) {
    const hit = (ev.target as Element | null)?.closest?.(PRESS_VISUAL) as HTMLElement | null;
    if (!hit || hit.hasAttribute('disabled') || hit.getAttribute('aria-disabled') === 'true')
      return;
    releasePress();
    pressRect = hit.getBoundingClientRect(); // capturé AVANT le scale
    pressedEl = hit;
    hit.setAttribute('data-pressed', '');
  }
  function onRootPointerMove(ev: PointerEvent) {
    if (!pressedEl || !pressRect) return;
    if (
      ev.clientX < pressRect.left ||
      ev.clientX > pressRect.right ||
      ev.clientY < pressRect.top ||
      ev.clientY > pressRect.bottom
    )
      releasePress();
  }
  function onRootClick(ev: MouseEvent) {
    releasePress();
    const hit = (ev.target as Element | null)?.closest?.(HAPTIC_TARGET);
    if (!hit) return;
    if (hit.closest('[data-no-haptic]')) return;
    if (hit.hasAttribute('disabled') || hit.getAttribute('aria-disabled') === 'true') return;
    haptic('light'); // confirme l'action (touchUpInside)
  }

  // ─── Hydrater les préférences (theme, animations…) global, dès le mount ─
  // Sans ça, un reload sur n'importe quelle page autre que /reglages
  // perd le theme dark.
  $effect(() => {
    preferences.hydrate();
  });

  // ─── Réglages métier (prix, coût/date installation) app-wide ──
  // Hydratés ici pour que l'accueil et l'énergie (ROI) y aient accès.
  $effect(() => {
    settings.hydrate();
  });

  // ─── Démo ticker (mock) — actif tant qu'on n'a pas de vraie source ─────
  $effect(() => {
    startDemoTicker();
    return () => stopDemoTicker();
  });

  // ─── Santé de la liaison domotique (bandeau d'alerte global) ───────────
  // Poll /api/health (état du hub MQTT). Visibility-aware, idempotent. Le
  // bandeau ne s'affiche qu'après le délai de grâce du store (auto-réparation
  // infra échouée), pour éviter d'alerter sur une coupure passagère.
  $effect(() => {
    health.connect();
    return () => health.disconnect();
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

  // ─── Compteur Shelly Pro EM-50 (réseau EDF + conso cumulus, mesure locale) ──
  // App-wide : alimente la carte « Compteur » (page Énergie) ET la sous-conso
  // cumulus du Sankey de l'accueil. Poll 10 s, visibility-aware, idempotent.
  $effect(() => {
    em50.connect();
    return () => em50.disconnect();
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

<!-- Titre centralisé : avec le pager (plusieurs pages montées), un <title> par page
     se télescoperait. Une seule source = la page active (curIdx). -->
<svelte:head>
  <title>{curIdx <= 0 ? 'Domo' : `${navItems[curIdx].label} · Domo`}</title>
</svelte:head>

<!-- Délégation PASSIVE : gère seulement l'enfoncement visuel + le retour haptique
     de confirmation ; les vraies interactions restent sur les boutons enfants (qui
     ont leur rôle). Un role ARIA ici serait trompeur → règles a11y désactivées. -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="min-h-screen"
  style="background: var(--color-bg); color: var(--color-fg);"
  onpointerdown={onRootPointerDown}
  onpointermove={onRootPointerMove}
  onpointerup={releasePress}
  onpointercancel={releasePress}
  onclick={onRootClick}
>
  <!-- Lien d'évitement (WCAG 2.4.1) : premier focalisable, visible seulement au clavier -->
  <a
    href="#main"
    class="sr-only rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60]"
    style="background: var(--color-primary); color: var(--color-primary-fg);"
  >
    Aller au contenu
  </a>

  <!-- Calque d'ambiance (halos verts/indigo) : matière pour le verre + profondeur -->
  <div class="app-ambient" aria-hidden="true"></div>

  <!-- Tirer-pour-rafraîchir (geste tactile en haut de page) -->
  <PullToRefresh />

  <Sidebar />

  <main
    id="main"
    tabindex="-1"
    class="safe-top min-h-screen sm:pl-[72px] lg:pl-[280px]"
    style="padding-bottom: calc(60px + env(safe-area-inset-bottom));"
  >
    <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
      <HealthBanner />
    </div>
    {#if pagerReady}
      <Pager />
    {:else}
      <!-- SSR + 1er paint : la page du routeur, avant que le Pager prenne la main -->
      <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
        {@render children()}
      </div>
    {/if}
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
