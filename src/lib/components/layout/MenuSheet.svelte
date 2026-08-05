<script lang="ts">
  /**
   * Feuille « ☰ » — point d'entrée unique du tiroir, présentée comme une feuille
   * modale iOS (grabber, coins arrondis, fond gris groupé) contenant la liste
   * des Réglages.
   *
   * Ne réutilise PAS BottomSheet : celui-ci porte le verre Yeldra (surface écrite
   * `background: var(--color-card)` → flou + arête bleue / ombre verte via
   * app.css). Le menu est volontairement affranchi de ce langage (cf.
   * `$lib/styles/ios-settings.css`). Tout le savoir-faire iOS de BottomSheet est
   * repris tel quel : verrou de défilement du body avec restauration du scrollY,
   * zone sûre du bas, fermeture Escape / tap-dehors, focus au panneau, animations
   * coupées sous reduced-motion.
   *
   * La feuille ne fait que NAVIGUER : chaque rubrique est une vraie page, ce qui
   * la garde courte sur iPhone et rend chaque destination rechargeable.
   */
  import '$lib/styles/ios-settings.css';
  import { afterNavigate } from '$app/navigation';
  import { menuSheet, closeMenu } from './menu-state.svelte';
  import MenuList from './MenuList.svelte';

  let panelEl = $state<HTMLDivElement | null>(null);

  // Verrou de défilement iOS : fige le body et restaure la position à la fermeture.
  $effect(() => {
    if (typeof document === 'undefined' || !menuSheet.open) return;
    const body = document.body;
    const scrollY = window.scrollY;
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    queueMicrotask(() => panelEl?.focus());
    return () => {
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  });

  // Filet : une navigation déclenchée autrement qu'au tap (retour matériel, lien
  // profond) ne doit pas laisser la feuille ouverte par-dessus la page.
  afterNavigate(() => closeMenu());

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeMenu();
  }
</script>

<svelte:window onkeydown={menuSheet.open ? onKeydown : undefined} />

{#if menuSheet.open}
  <!-- data-swipe-ignore : neutralise le pager 2 doigts ; data-no-ptr : le
       tirer-pour-rafraîchir ignore la feuille (même intention que BottomSheet). -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ms-overlay" role="presentation" data-swipe-ignore data-no-ptr onclick={closeMenu}>
    <div
      class="ios ms-panel"
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="ms-header">
        <h1 class="ios-large-title">Menu</h1>
        <button type="button" class="ms-close" onclick={closeMenu} aria-label="Fermer">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <MenuList onNavigate={closeMenu} />

      <!-- Grabber : la poignée grise des feuilles iOS. Décorative. Elle marque
           le bord LIBRE de la feuille — passé en bas avec l'ancrage haut, comme
           le Centre de notifications d'iOS. Collée par `sticky` : sur une liste
           longue, en fin de contenu, elle serait invisible sans défiler. -->
      <span class="ms-grabber" aria-hidden="true"></span>
    </div>
  </div>
{/if}

<style>
  .ms-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    /* Assombrissement de la feuille modale iOS (la page reste devinable). */
    background: oklch(0 0 0 / 0.4);
  }
  .ms-panel {
    width: 100%;
    /* dvh : même raison que BottomSheet — ancrée en haut, le vh de Safari
       (barre d'URL incluse) ferait déborder le bas sous l'écran visible. */
    max-height: 90vh;
    max-height: 90dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    /* Ancrée en HAUT depuis le 04/08/2026, comme les autres feuilles : posée
       en bas, elle laissait ses premières entrées hors de portée sur iPhone.
       Zone sûre du haut = encoche / Dynamic Island. */
    border-bottom-left-radius: 14px;
    border-bottom-right-radius: 14px;
    padding: calc(8px + env(safe-area-inset-top)) 16px 20px;
    animation: ms-down 300ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .ms-panel:focus {
    outline: none;
  }
  @media (min-width: 1024px) {
    .ms-overlay {
      align-items: center;
      padding: 1rem;
    }
    .ms-panel {
      max-width: 30rem;
      border-radius: 14px;
      /* Centrée : aucune arête ne touche un bord, la zone sûre ne sert plus. */
      padding-top: 8px;
      animation: ms-fade 180ms ease;
    }
  }

  .ms-grabber {
    display: block;
    position: sticky;
    bottom: 0;
    width: 36px;
    height: 5px;
    margin: 8px auto 0;
    border-radius: 3px;
    background: var(--ios-label3);
    opacity: 0.55;
  }
  .ms-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  /* Bouton de fermeture rond gris — celui des feuilles iOS modernes. */
  .ms-close {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: var(--ios-field);
    color: var(--ios-label2);
    cursor: pointer;
  }

  @keyframes ms-down {
    from {
      transform: translateY(-100%);
    }
    to {
      transform: translateY(0);
    }
  }
  @keyframes ms-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ms-panel {
      animation: none;
    }
  }
</style>
