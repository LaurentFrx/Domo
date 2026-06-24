<script lang="ts">
  import '../app.css';
  import { page, updated } from '$app/state';
  import { beforeNavigate, goto } from '$app/navigation';
  import { navItems, isActive } from '$components/layout/nav-items';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import PullToRefresh from '$components/layout/PullToRefresh.svelte';
  import HealthBanner from '$components/layout/HealthBanner.svelte';
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

  // ─── Navigation par glissé à DEUX doigts (sans gêner les gestes à 1 doigt) ──
  // À 1 doigt : rien d'intercepté (scroll, sliders, tirer-pour-rafraîchir intacts).
  // À 2 doigts horizontal : le contenu suit les doigts (résistance en bout de liste)
  // et une pastille de bord annonce la page cible ; au relâché franchi → bascule.
  // Garde-fous : pincement (zoom) rejeté, geste vertical laissé au scroll, et le
  // canvas 3D de /maison exclu (data-swipe-ignore) pour ne pas voler sa rotation.
  const SWIPE_COMMIT = 80; // px (après résistance) pour déclencher la bascule
  let dragX = $state(0);
  let dragging = $state(false);
  let settling = $state(false); // transition de retour/bascule en cours

  const curIdx = $derived(navItems.findIndex((it) => isActive(page.url.pathname, it.href)));
  const targetIdx = $derived(dragX > 0 ? curIdx - 1 : dragX < 0 ? curIdx + 1 : -1);
  const swipeTarget = $derived(
    targetIdx >= 0 && targetIdx < navItems.length ? navItems[targetIdx] : null
  );
  const swipeProgress = $derived(Math.min(1, Math.abs(dragX) / SWIPE_COMMIT));

  $effect(() => {
    let armed = false;
    let locked = false;
    let startX = 0;
    let startY = 0;
    let startSpread = 0;
    const mid = (t: TouchList, k: 'clientX' | 'clientY') => (t[0][k] + t[1][k]) / 2;
    const spread = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const ignored = (el: EventTarget | null) =>
      !!(el as Element | null)?.closest?.('canvas, [data-swipe-ignore]');

    function onStart(e: TouchEvent) {
      if (settling || e.touches.length !== 2 || ignored(e.target)) {
        armed = false;
        locked = false;
        return;
      }
      armed = true;
      locked = false;
      startX = mid(e.touches, 'clientX');
      startY = mid(e.touches, 'clientY');
      startSpread = spread(e.touches);
      dragX = 0;
    }
    function onMove(e: TouchEvent) {
      if (!armed || e.touches.length !== 2) return;
      const dx = mid(e.touches, 'clientX') - startX;
      const dy = mid(e.touches, 'clientY') - startY;
      // Écartement des doigts qui varie beaucoup = pincement (zoom) → on abandonne.
      if (Math.abs(spread(e.touches) - startSpread) > 40) {
        armed = false;
        locked = false;
        if (dragX !== 0) dragX = 0;
        return;
      }
      if (!locked) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; // attendre l'intention
        if (Math.abs(dx) <= Math.abs(dy)) {
          armed = false; // geste plutôt vertical → laisser le scroll
          return;
        }
        locked = true;
      }
      if (e.cancelable) e.preventDefault();
      dragging = true;
      const hasTarget = (dx > 0 && curIdx > 0) || (dx < 0 && curIdx < navItems.length - 1);
      dragX = dx * (hasTarget ? 0.6 : 0.18); // résistance « caoutchouc » en bout de liste
    }
    function onEnd() {
      if (!locked) {
        armed = false;
        return;
      }
      armed = false;
      locked = false;
      dragging = false;
      const tgt = swipeTarget;
      if (Math.abs(dragX) > SWIPE_COMMIT && tgt) {
        haptic('light');
        settling = true;
        dragX = 0;
        goto(tgt.href).finally(() => (settling = false));
      } else {
        settling = true;
        dragX = 0;
        setTimeout(() => (settling = false), 220);
      }
    }
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
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
    <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8" style="overflow-x: clip;">
      <HealthBanner />
      <!-- Shell qui suit les doigts pendant le glissé 2 doigts (transform piloté plus haut) -->
      <div class="swipe-shell" class:swipe-anim={!dragging} style:transform="translateX({dragX}px)">
        {#key page.url.pathname}
          <div class="page-enter">
            {@render children()}
          </div>
        {/key}
      </div>
    </div>
  </main>

  <TabBar />

  <!-- Pastille de bord pendant le glissé 2 doigts : annonce la page cible -->
  {#if dragging && swipeTarget}
    <div
      class="swipe-hint"
      class:swipe-hint-right={dragX < 0}
      class:swipe-hint-ready={swipeProgress >= 1}
      style:opacity={swipeProgress}
      aria-hidden="true"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={swipeTarget.icon} />
      </svg>
      <span>{swipeTarget.label}</span>
    </div>
  {/if}
</div>

<style>
  /* Compense le padding-bottom sur les écrans sm+ (tab bar masquée) */
  @media (min-width: 640px) {
    main {
      padding-bottom: 0 !important;
    }
  }

  /* ─── Glissé 2 doigts : suivi du contenu + pastille de bord ─── */
  .swipe-shell {
    will-change: transform;
  }
  /* Transition seulement HORS glissé (retour élastique / bascule) : pendant le
     glissé, le contenu suit le doigt sans inertie. */
  .swipe-anim {
    transition: transform var(--duration-normal) var(--ease-out);
  }
  .swipe-hint {
    position: fixed;
    top: 50%;
    left: 12px;
    transform: translateY(-50%);
    z-index: 55;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: var(--radius-pill);
    background: var(--color-card-hover);
    border: 1px solid var(--color-border);
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 6px 20px -8px oklch(0.1 0.01 286 / 0.4);
  }
  .swipe-hint-right {
    left: auto;
    right: 12px;
  }
  .swipe-hint-ready {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
  @media (prefers-reduced-motion: reduce) {
    .swipe-anim {
      transition: none;
    }
  }
</style>
