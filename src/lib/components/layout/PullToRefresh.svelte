<script lang="ts">
  import { onMount } from 'svelte';
  import { updated } from '$app/state';
  import { haptic } from '$utils/haptic';
  import { player } from '$stores/plex.svelte';

  // Tirer-pour-rafraîchir (iOS-first). Les pages Domo défilent au niveau de la
  // fenêtre (pas de conteneur interne) → on écoute les touch sur window. Geste
  // armé uniquement quand on est tout en haut (scrollY ≤ 0) et qu'on commence
  // hors d'un contrôle interactif (pour ne pas voler un drag de slider/bouton).

  const THRESHOLD = 70; // px (après résistance) pour déclencher
  const MAX = 110; // px d'amplitude visuelle max
  const RESISTANCE = 0.5; // tirage « caoutchouc »

  let pull = $state(0);
  let refreshing = $state(false);
  let armed = false;
  let startY = 0;

  const ready = $derived(pull >= THRESHOLD);
  const progress = $derived(Math.min(1, pull / THRESHOLD));

  function isInteractive(target: EventTarget | null): boolean {
    const el = target as Element | null;
    return !!el?.closest?.(
      'button, [role="button"], [role="switch"], [role="slider"], input, a[href], summary, [data-no-ptr]'
    );
  }

  /**
   * Le geste est-il parti de l'intérieur d'une couche modale ?
   *
   * `window.scrollY > 0` ne suffit PAS à s'en protéger, et c'est contre-intuitif :
   *  • BottomSheet verrouille le défilement en posant `body.style.position =
   *    'fixed'` — le document ne défile plus, donc scrollY vaut TOUJOURS 0 tant
   *    qu'une feuille est ouverte, quelle que soit la position de la page dessous ;
   *  • la feuille « Now Playing » est en `position: fixed` et défile en interne,
   *    sans jamais toucher scrollY.
   * Un glissé vers le bas sur une zone non interactive (pochette d'album, courbe
   * de température, libellé de formulaire) armait donc le tirer-pour-rafraîchir
   * et rechargeait l'app au relâché : musique coupée, feuille fermée, champs non
   * enregistrés perdus.
   */
  function inModal(target: EventTarget | null): boolean {
    const el = target as Element | null;
    if (el?.closest?.('[role="dialog"], [aria-modal="true"]')) return true;
    // Filet complémentaire : le verrou de défilement de BottomSheet.
    return typeof document !== 'undefined' && document.body.style.position === 'fixed';
  }

  function onTouchStart(e: TouchEvent) {
    if (refreshing || e.touches.length !== 1) return;
    if (window.scrollY > 0) return;
    if (isInteractive(e.target)) return;
    if (inModal(e.target)) return;
    startY = e.touches[0].clientY;
    armed = true;
  }

  function onTouchMove(e: TouchEvent) {
    if (!armed || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      pull = 0;
      armed = dy > 0; // si on remonte au-dessus du top on garde l'armement
      return;
    }
    pull = Math.min(MAX, dy * RESISTANCE);
    // Empêche le rubber-band natif pendant qu'on tire l'indicateur.
    if (pull > 3 && e.cancelable) e.preventDefault();
  }

  /** Refetch de TOUS les stores actifs, sans recharger la page.
   *
   * Même chemin que le retour de visibilité : chaque store visibility-aware
   * refait un poll immédiat sur cet événement (et zigbee rouvre son SSE) —
   * l'app étant réellement visible, tous les handlers prennent la branche
   * « visible ». L'ancien `location.reload()` payait un aller-retour SSR +
   * re-téléchargement du JS + réhydratation + remontage du pager (le HTML n'est
   * jamais en cache SW) et COUPAIT LA MUSIQUE, pour des données que les stores
   * savent déjà rafraîchir en ~200 ms. */
  function refreshStores() {
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function onTouchEnd() {
    if (!armed) return;
    armed = false;
    if (ready && !refreshing) {
      refreshing = true;
      pull = THRESHOLD;
      haptic('success');
      // Nouvelle version déployée et personne n'écoute : le geste est le moment
      // idéal pour recharger le code (même garde musique que le layout).
      if (updated.current && !player.current) {
        setTimeout(() => location.reload(), 380);
        return;
      }
      refreshStores();
      // Le spinner tourne le temps que les fetchs reviennent (~150-500 ms) ;
      // les cartes se mettent à jour d'elles-mêmes via les stores.
      setTimeout(() => {
        refreshing = false;
        pull = 0;
      }, 700);
    } else {
      pull = 0;
    }
  }

  onMount(() => {
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  });
</script>

<div
  class="ptr safe-top"
  style:transform="translateX(-50%) translateY({pull}px)"
  style:opacity={refreshing ? 1 : progress}
  aria-hidden="true"
>
  <span class="ptr-badge" class:ptr-ready={ready} class:ptr-spin={refreshing}>
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      style:transform={refreshing ? 'none' : `rotate(${pull * 2.6}deg)`}
    >
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
      />
      <path
        d="M21 3v5h-5"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
</div>

<style>
  .ptr {
    position: fixed;
    top: -2px;
    left: 50%;
    z-index: 60;
    pointer-events: none;
    display: flex;
    justify-content: center;
    /* L'indicateur démarre juste au-dessus du bord (caché) et descend avec le tir. */
    margin-top: -44px;
    transition: opacity 160ms var(--ease-default);
  }
  .ptr-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 9999px;
    color: var(--color-primary);
    background: var(--color-card);
    border: 1px solid var(--color-border);
    box-shadow:
      0 1px 0 oklch(1 0 0 / 0.5) inset,
      0 6px 16px -6px oklch(0.1 0.01 286 / 0.35);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    transition:
      color 160ms var(--ease-default),
      box-shadow 160ms var(--ease-default),
      border-color 160ms var(--ease-default);
  }
  .ptr-ready {
    color: var(--color-battery);
    border-color: var(--color-battery);
    box-shadow:
      0 1px 0 oklch(1 0 0 / 0.5) inset,
      0 6px 16px -4px var(--color-battery-glow);
  }
  .ptr-badge svg {
    transition: transform 80ms linear;
  }
  .ptr-spin {
    animation: ptr-rotate 0.7s linear infinite;
  }
  @keyframes ptr-rotate {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ptr-spin {
      animation-duration: 1.6s;
    }
  }
</style>
