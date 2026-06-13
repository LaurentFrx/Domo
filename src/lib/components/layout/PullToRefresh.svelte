<script lang="ts">
  import { onMount } from 'svelte';
  import { haptic } from '$utils/haptic';

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

  function onTouchStart(e: TouchEvent) {
    if (refreshing || e.touches.length !== 1) return;
    if (window.scrollY > 0) return;
    if (isInteractive(e.target)) return;
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

  function onTouchEnd() {
    if (!armed) return;
    armed = false;
    if (ready && !refreshing) {
      refreshing = true;
      pull = THRESHOLD;
      haptic('success');
      // Court délai pour laisser voir le spinner, puis vrai refresh (re-mount
      // des pages → reconnexion des stores → données fraîches).
      setTimeout(() => location.reload(), 380);
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
