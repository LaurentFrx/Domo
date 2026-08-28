<script lang="ts">
  import '../app.css';
  import { page, updated } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { navItems } from '$components/layout/nav-items';
  import { pageTitleFor } from '$components/layout/menu-items';
  import { activeNavHref } from '$lib/pager/pager-nav.svelte';
  import { onMount } from 'svelte';
  import Sidebar from '$components/layout/Sidebar.svelte';
  import TabBar from '$components/layout/TabBar.svelte';
  import MenuSheet from '$components/layout/MenuSheet.svelte';
  import PullToRefresh from '$components/layout/PullToRefresh.svelte';
  import HealthBanner from '$components/layout/HealthBanner.svelte';
  import TempHistorySheet from '$components/temperature/TempHistorySheet.svelte';
  import WledSheet from '$components/cards/WledSheet.svelte';
  import { wledSheet, closeWledSheet } from '$components/cards/wled-sheet-state.svelte';
  import MiniPlayer from '$components/music/MiniPlayer.svelte';
  import { player } from '$stores/plex.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import Pager from '$lib/pager/Pager.svelte';
  import { anker } from '$stores/anker.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { ankerLocal } from '$stores/ankerLocal.svelte';
  import { savings } from '$stores/savings.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { settings } from '$stores/settings.svelte';
  import { health } from '$stores/health.svelte';
  import { clock } from '$stores/clock.svelte';
  import { haptic } from '$utils/haptic';
  import { PORTAL_TARGET_ID } from '$utils/portal';
  import { setupServiceWorker } from '$lib/sw-client';

  let { children } = $props();

  // ─── Page active (titre + condition pager) ────────────────────────────
  // activeNavHref reflète la page centrale du PAGER quand il pilote (page.url ne
  // suit pas le pushState d'un swipe).
  const activeHref = $derived(activeNavHref(page.url.pathname));
  const curIdx = $derived(navItems.findIndex((it) => it.href === activeHref));
  // Le pager ne pilote que les routes EXACTES de navItem ; les sous-routes et
  // l'espace du menu (/menu/…) restent rendus par le routeur (children).
  const onNavItem = $derived(navItems.some((n) => n.href === page.url.pathname));

  // Titre d'onglet : une SEULE source (plusieurs pages sont montées à la fois sous
  // le pager, un <title> par page se télescoperait). Les pages hors navigation
  // (menu, planning, labo) ont leur propre registre ; sinon on suit le pager.
  const offNavTitle = $derived(pageTitleFor(page.url.pathname));
  const docTitle = $derived(
    offNavTitle
      ? `${offNavTitle} · Domo`
      : curIdx <= 0
        ? 'Domo'
        : `${navItems[curIdx].label} · Domo`
  );

  // ─── Pager (rail unifié, physique de ressort) ─────────────────────────
  // Rendu CÔTÉ CLIENT après hydratation : SSR + 1er paint = la page du routeur
  // (children) ; puis le Pager prend la main (rail keyé par href, ressort seedé par
  // la vitesse du doigt, commit par pushState → zéro re-montage). Cf. src/lib/pager/.
  let pagerReady = $state(false);
  onMount(() => {
    pagerReady = true;
    // Le service worker n'était enregistré que par push-client (activation des
    // notifications) et n'était JAMAIS revérifié : l'app restait servie depuis
    // le precache de ce jour-là. Ici, il est enregistré au démarrage et
    // revérifié au retour au premier plan.
    // Même garde que pour beforeNavigate : on ne recharge pas sous les pieds
    // de quelqu'un qui écoute. Le rechargement est différé, pas annulé.
    setupServiceWorker(() => !player.current);
  });

  // ─── Suivi musique → éclairage terrasse ────────────────────────────────
  // Le lecteur est global (MiniPlayer ci-dessous) : on observe piste + lecture
  // + position ici pour que la terrasse suive la musique quelle que soit la
  // page ouverte. La position (currentTime, poussée par l'événement audio
  // `timeupdate`) alimente le heartbeat — elle continue d'évoluer en
  // arrière-plan iOS tant que la musique joue, contrairement aux timers.
  // No-op immédiat quand le mode est désactivé (sync idempotent).
  $effect(() => {
    wledMusic.sync(player.current, player.playing, player.currentTime);
  });
  // Le canal temps réel lumière/musique est ouvert EN PERMANENCE (suspendu en
  // arrière-plan par le store) : il porte l'état du mode ET l'état réel du
  // module — c'est lui qui rend tuile, feuille et bouton Lumière véridiques
  // partout, sans dépendre de la page ouverte. L'ancien abonnement conditionné
  // à « une piste joue » laissait le lecteur avec des segments jamais chargés.
  $effect(() => {
    wledMusic.openLive();
    return () => wledMusic.closeLive();
  });

  // ─── Auto-reload après déploiement (anti « client périmé ») ─────────────
  // À chaque déploiement, les chunks JS changent de hash : un onglet/PWA déjà
  // ouvert garde d'anciennes références → une navigation client échoue à charger
  // les modules et l'app « ne répond plus ». `version.pollInterval` (svelte.config)
  // détecte la nouvelle version (`updated.current`) ; on force alors une navigation
  // PLEINE page (location.href) qui recharge le code à jour. Filet durable.
  //
  // MAIS PAS PENDANT UNE ÉCOUTE. Un rechargement plein détruit le contexte JS,
  // donc l'élément <audio> : la musique s'arrête net, et iOS interdit de la
  // relancer sans geste de l'utilisateur — impossible de reprendre tout seul.
  // Vécu le 18/08 : deux déploiements dans l'heure, et le premier passage dans
  // le menu coupait la musique. On diffère : la mise à jour se fera à la
  // navigation suivante une fois la lecture terminée. Si un module manquait
  // vraiment d'ici là, le routeur SvelteKit bascule de lui-même en navigation
  // pleine page — on ne perd donc pas le filet, on cesse juste de le tendre
  // au mauvais moment.
  beforeNavigate(({ willUnload, to }) => {
    if (!updated.current || !to?.url || willUnload) return;
    // `current` et pas `playing` : entre deux morceaux, ou sur une pause de
    // quelques secondes, la file reste chargée et l'utilisateur est en train
    // d'écouter. Recharger là est tout aussi brutal.
    if (player.current) return;
    location.href = to.url.href;
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
  // Sans ça, un reload sur n'importe quelle page autre que /menu/apparence
  // perd le theme dark.
  $effect(() => {
    preferences.hydrate();
  });

  // ─── Réglages métier (prix, coût/date installation) app-wide ──
  // Hydratés ici pour que l'accueil et l'énergie (ROI) y aient accès.
  $effect(() => {
    settings.hydrate();
  });

  // ─── Horloge partagée (âge des mesures) ────────────────────────────────
  // Une seule pour toute l'app : sans elle, « mesuré il y a 4 min » se fige,
  // et une horloge par carte multiplierait les timers. Visibility-aware.
  $effect(() => {
    clock.connect();
    return () => clock.disconnect();
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

  // ─── Anker Solix LOCAL (Modbus : Solarbank Max AC + Smart Meter Gen 2) ──
  // App-wide : le SoC/flux batterie de l'ACCUEIL fusionne la Max AC locale
  // (absente de batteries[] du cloud) avec les Solarbank 3 cloud — la tuile
  // /energie le consomme aussi. Poll 10 s, visibility-aware, idempotent.
  $effect(() => {
    ankerLocal.connect();
    return () => ankerLocal.disconnect();
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

  // Le miroir « Anker → dashboard » a été SUPPRIMÉ avec le store dashboard :
  // c'est lui qui décidait du mode « mock ». L'app démarrait en démonstration
  // (connectionStatus valait 'mock' à l'initialisation) et y RETOURNAIT
  // automatiquement dès qu'Anker décrochait — en production. Les cartes lisent
  // désormais les stores de mesure directement.
</script>

<!-- Titre centralisé : avec le pager (plusieurs pages montées), un <title> par page
     se télescoperait. Une seule source = la page active (curIdx). -->
<svelte:head>
  <title>{docTitle}</title>
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

  <!-- `--mini-h` : la place que le mini-player prend au bas de l'écran, 0 quand
       il n'y a pas de lecture. Sans elle, il masquait la fin de CHAQUE page
       (dernière carte, dernier bouton) — il flotte en `position: fixed`, donc
       rien ne lui réserve d'espace. Le mini fait 62 px + son écart au bord. -->
  <main
    id="main"
    tabindex="-1"
    class="safe-top desk:pl-[280px] min-h-screen sm:pl-[72px]"
    class:has-mini={!!player.current}
    style="padding-bottom: calc(60px + env(safe-area-inset-bottom) + var(--mini-h, 0px));"
  >
    <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
      <HealthBanner />
    </div>
    {#if pagerReady && onNavItem}
      <Pager />
    {:else}
      <!-- SSR/1er paint + espace du menu (/menu/…) : rendu par le routeur -->
      <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
        {@render children()}
      </div>
    {/if}
  </main>

  <TabBar />

  <!-- Feuille « ☰ » GLOBALE : montée une seule fois, ouverte par la TabBar (iPhone)
       comme par la Sidebar (iPad/desktop). -->
  <MenuSheet />

  <!-- Mini-player musique GLOBAL (+ feuille Now Playing) : n'apparaît que si une
       file de lecture existe. L'audio vit dans le store `player` (module-level),
       la musique survit donc aux navigations et aux swipes du pager. -->
  <MiniPlayer />

  <!-- Pop-up global « historique de température 4 h » (piloté par openTempHistory) -->
  <TempHistorySheet />

  <!-- Feuille de réglages terrasse GLOBALE : la tuile vit dans /pieces, donc
       DANS le rail du Pager (`will-change: transform` + `overflow: hidden`),
       qui piège tout `position: fixed` — montée là-bas, la feuille s'ouvrait
       hors écran. Ici, elle s'ancre au vrai viewport. -->
  <WledSheet open={wledSheet.open} onClose={closeWledSheet} />

  <!-- Ancre de l'action `portal` ($utils/portal) : les pages du Pager y
       re-parentent leurs modales position:fixed — laissées dans la page, le
       rail (`will-change: transform`) en ferait le référentiel et les
       ancrerait hors écran. Doit rester DANS ce <div> racine (délégation
       d'événements Svelte 5 + enfoncement/haptique iOS ci-dessus). -->
  <div id={PORTAL_TARGET_ID}></div>
</div>

<style>
  /* Place réservée au mini-player quand une lecture est en cours : 62 px de
     hauteur + 10 px d'écart au-dessus de la TabBar. */
  main.has-mini {
    --mini-h: 72px;
  }
  /* Compense le padding-bottom sur les écrans sm+ (tab bar masquée) — mais le
     mini-player, lui, y est TOUJOURS (collé à 16 px du bas) : il garde donc sa
     place réservée, 62 px + 16 px d'écart. */
  @media (min-width: 640px) {
    main {
      padding-bottom: 0 !important;
    }
    main.has-mini {
      padding-bottom: 94px !important;
    }
  }
</style>
