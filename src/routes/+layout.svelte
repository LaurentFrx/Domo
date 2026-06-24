<script lang="ts">
  import '../app.css';
  import { page, updated } from '$app/state';
  import { beforeNavigate, goto } from '$app/navigation';
  import { navItems, isActive, type NavItem } from '$components/layout/nav-items';
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

  // ─── Navigation par glissé à DEUX doigts, avec aperçu « push » iOS ──────────
  // À 1 doigt : rien d'intercepté (scroll, sliders, tirer-pour-rafraîchir intacts).
  // À 2 doigts horizontal : la page courante recule en suivant les doigts et la
  // page CIBLE glisse PAR-DESSUS depuis le bord (continuité visuelle). Au lâcher
  // franchi, la cible finit sa course (plein écran = couverture pendant le chargement)
  // puis la vraie page se monte ; sinon retour élastique.
  // Garde-fous : pincement (zoom) rejeté, geste vertical laissé au scroll. Le 3D de
  // /maison garde sa rotation 1 doigt et son zoom-pincement ; seul le pan 2 doigts
  // cède à la navigation (opt-out ciblé possible via [data-swipe-ignore]).
  const SWIPE_COMMIT = 70; // px (après résistance) pour déclencher la bascule
  let dragX = $state(0);
  let dragging = $state(false); // doigt en cours : suivi direct, sans transition
  let committing = $state(false); // bascule en cours : la cible glisse jusqu'au plein écran
  let settling = $state(false); // retour élastique (annulation)
  let noAnim = $state(false); // reset instantané après navigation (anti-glissement)

  // Cible + côtés figés pendant les animations ; vivants pendant le drag.
  let frozenTarget = $state<NavItem | null>(null);
  let frozenBasePct = 0; // côté d'où vient le panneau cible (±100)
  let frozenShellPct = 0; // côté où sort la page courante (±100)
  let pendingHref = '';
  let commitFallback: ReturnType<typeof setTimeout> | undefined;

  const curIdx = $derived(navItems.findIndex((it) => isActive(page.url.pathname, it.href)));
  // Direction VIVE pendant le drag : dragX<0 → page suivante (vient de droite).
  const liveBasePct = $derived(dragX < 0 ? 100 : -100);
  const liveTargetIdx = $derived(dragX < 0 ? curIdx + 1 : dragX > 0 ? curIdx - 1 : -1);
  const liveTarget = $derived(
    liveTargetIdx >= 0 && liveTargetIdx < navItems.length ? navItems[liveTargetIdx] : null
  );

  const swipeActive = $derived(dragging || committing || settling);
  const peekTarget = $derived(committing || settling ? frozenTarget : liveTarget);
  const peekVisible = $derived(swipeActive && !!peekTarget);

  // Transforms : px pendant le drag (suivi direct), % pendant les animations.
  const shellTransform = $derived(
    committing
      ? `translateX(${frozenShellPct}%)`
      : dragging
        ? `translateX(${dragX}px)`
        : 'translateX(0)'
  );
  const peekTransform = $derived(
    committing
      ? 'translateX(0)'
      : settling
        ? `translateX(${frozenBasePct}%)`
        : `translateX(calc(${liveBasePct}% + ${dragX}px))`
  );

  function finishNavigate() {
    if (!committing || !pendingHref) return;
    clearTimeout(commitFallback);
    const href = pendingHref;
    pendingHref = '';
    goto(href).then(() => {
      // La vraie cible est montée : on remet tout en place SANS transition,
      // sinon la page neuve glisserait depuis le bord.
      noAnim = true;
      committing = false;
      dragX = 0;
      frozenTarget = null;
      requestAnimationFrame(() => requestAnimationFrame(() => (noAnim = false)));
    });
  }
  function onShellTransitionEnd(e: TransitionEvent) {
    // Seulement la fin de transition PROPRE au shell (pas un enfant page-enter).
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (committing) finishNavigate();
  }

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
      !!(el as Element | null)?.closest?.('[data-swipe-ignore]');

    function onStart(e: TouchEvent) {
      if (committing || settling || e.touches.length !== 2 || ignored(e.target)) {
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
        dragging = false;
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
      e.stopPropagation(); // coupe le geste pour le 3D /maison (et tout handler enfant)
      dragging = true;
      const hasTarget = (dx > 0 && curIdx > 0) || (dx < 0 && curIdx < navItems.length - 1);
      dragX = dx * (hasTarget ? 0.85 : 0.18); // suivi quasi 1:1, résistance en bout de liste
    }
    function onEnd() {
      if (!locked) {
        armed = false;
        return;
      }
      armed = false;
      locked = false;
      const tgt = liveTarget;
      if (Math.abs(dragX) > SWIPE_COMMIT && tgt) {
        haptic('light');
        frozenTarget = tgt;
        frozenBasePct = dragX < 0 ? 100 : -100;
        frozenShellPct = dragX < 0 ? -100 : 100;
        pendingHref = tgt.href;
        committing = true;
        dragging = false; // transition active → page sort, cible arrive à 0
        commitFallback = setTimeout(finishNavigate, 380); // filet si transitionend muet
      } else {
        frozenTarget = tgt;
        frozenBasePct = dragX < 0 ? 100 : -100;
        settling = true;
        dragging = false;
        dragX = 0; // ressort
        setTimeout(() => {
          settling = false;
          frozenTarget = null;
        }, 240);
      }
    }
    // touchmove en CAPTURE : on passe AVANT les handlers enfants (canvas 3D) pour
    // pouvoir stopPropagation une fois le glissé verrouillé.
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false, capture: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove, true);
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
    <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8" style="overflow-x: clip;">
      <HealthBanner />
      <!-- Page courante : recule en suivant les doigts ; la cible glisse par-dessus -->
      <div
        class="swipe-shell"
        class:swipe-anim={!dragging}
        class:swipe-noanim={noAnim}
        style:transform={shellTransform}
        ontransitionend={onShellTransitionEnd}
      >
        {#key page.url.pathname}
          <div class="page-enter">
            {@render children()}
          </div>
        {/key}
      </div>
    </div>
  </main>

  <TabBar />

  <!-- Aperçu « push » : la page cible glisse par-dessus pendant le glissé 2 doigts -->
  {#if peekVisible && peekTarget}
    <div class="swipe-peek-clip" aria-hidden="true">
      <div
        class="swipe-peek"
        class:swipe-anim={!dragging}
        class:swipe-noanim={noAnim}
        style:transform={peekTransform}
      >
        <div class="swipe-peek-inner">
          <span class="swipe-peek-icon">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d={peekTarget.icon} />
            </svg>
          </span>
          <span class="swipe-peek-label">{peekTarget.label}</span>
        </div>
      </div>
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

  /* ─── Glissé 2 doigts : page courante + aperçu « push » de la cible ─── */
  .swipe-shell {
    will-change: transform;
  }
  /* Transition HORS glissé seulement (retour / bascule) : pendant le glissé,
     contenu et aperçu suivent le doigt sans inertie. */
  .swipe-anim {
    transition: transform var(--duration-normal) var(--ease-out);
  }
  /* Reset post-navigation : aucun glissement de la page neuve. */
  .swipe-noanim {
    transition: none !important;
  }
  /* Conteneur plein écran qui CLIPPE l'aperçu hors-cadre (pas de scroll horizontal).
     Sous la Sidebar (40) et la TabBar (50) : elles restent visibles au-dessus. */
  .swipe-peek-clip {
    position: fixed;
    inset: 0;
    z-index: 30;
    overflow: hidden;
    pointer-events: none;
  }
  .swipe-peek {
    position: absolute;
    inset: 0;
    background: var(--color-bg);
    display: flex;
    align-items: center;
    justify-content: center;
    will-change: transform;
  }
  .swipe-peek-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    /* Recentre optiquement au-dessus de la TabBar mobile. */
    padding-bottom: calc(60px + env(safe-area-inset-bottom));
  }
  .swipe-peek-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: var(--radius-2xl);
    background: var(--color-card-hover);
    border: 1px solid var(--color-border);
    color: var(--color-primary);
  }
  .swipe-peek-label {
    font-size: 17px;
    font-weight: 600;
    color: var(--color-fg);
  }
  @media (prefers-reduced-motion: reduce) {
    .swipe-anim {
      transition: none;
    }
  }
</style>
