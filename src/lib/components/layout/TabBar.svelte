<script lang="ts">
  import { page } from '$app/state';
  import { navItems } from './nav-items';
  import { MENU_ICON, isMenuDestination } from './menu-items';
  import { menuSheet, openMenu } from './menu-state.svelte';
  import { activeNavHref } from '$lib/pager/pager-nav.svelte';

  // Dans une destination du menu (/menu/…, mais aussi /energie et /maison qu'il
  // ouvre), AUCUN onglet de pilotage ne doit s'allumer : `activeNavHref` retombe
  // sur '/' par défaut (le pager n'y est pas monté), ce qui ferait briller Accueil
  // à tort. C'est le bouton « ☰ » qui porte l'état actif.
  const inMenu = $derived(isMenuDestination(page.url.pathname));

  // ─── Clavier iOS : garder la barre vraiment collée en bas ──────────────────
  // Une barre `position: fixed` est ancrée au viewport de MISE EN PAGE, pas au
  // viewport VISUEL. Quand le clavier iOS s'ouvre (saisie d'un prix dans
  // Réglages, etc.), il rétrécit le viewport visuel et la barre « flotte »
  // au-dessus du clavier au milieu de l'écran. On la masque tant qu'un champ
  // éditable a le focus (le clavier est alors ouvert).
  let keyboardOpen = $state(false);
  function opensKeyboard(el: EventTarget | null): boolean {
    const node = el as HTMLElement | null;
    if (!node) return false;
    const tag = node.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (node as HTMLInputElement).type;
      // Ces types n'ouvrent pas de clavier (interrupteurs, curseurs, fichiers…).
      return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(
        type
      );
    }
    return node.isContentEditable;
  }
  // Le focus seul est une heuristique : il dit qu'un champ-clavier est actif,
  // pas que le clavier occulte réellement le bas. On arbitre avec visualViewport
  // (source de vérité) → on ne masque QUE si le clavier rogne vraiment >120px.
  // Bénéfice cross-plateforme : iOS (clavier en surimpression → gros écart →
  // masque) vs Android (clavier qui redimensionne le viewport → écart ~0 → la
  // barre fixed remonte d'elle-même, inutile de masquer). Fallback = focus seul
  // sur les navigateurs sans visualViewport. Corrige aussi l'iPad « masquer le
  // clavier » en gardant le focus (resize → la barre réapparaît).
  $effect(() => {
    let focused = false;
    const vv = window.visualViewport;
    const sync = () => {
      const occluded = vv ? window.innerHeight - vv.height > 120 : true;
      keyboardOpen = focused && occluded;
    };
    const onFocusIn = (e: FocusEvent) => {
      if (opensKeyboard(e.target)) {
        focused = true;
        sync();
      }
    };
    const onFocusOut = () => {
      // `focusout` est aussi émis quand le nœud focalisé est RETIRÉ du DOM —
      // typiquement à la fermeture d'une BottomSheet, donc en plein démontage
      // d'effets Svelte, où toute écriture d'état lève `state_unsafe_mutation`.
      // 1) aucun champ-clavier n'était suivi → il n'y a rien à annuler ;
      // 2) sinon on repousse l'écriture d'une microtâche, hors du démontage.
      if (!focused) return;
      focused = false;
      queueMicrotask(sync);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    vv?.addEventListener('resize', sync);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      vv?.removeEventListener('resize', sync);
    };
  });
</script>

<nav
  class="tabbar fixed right-0 bottom-0 left-0 z-50 border-t sm:hidden"
  class:tabbar-hidden={keyboardOpen}
  style="
    background: var(--color-bg);
    border-color: var(--color-border);
    padding-bottom: env(safe-area-inset-bottom);
    height: calc(60px + env(safe-area-inset-bottom));
  "
  aria-label="Navigation principale"
  inert={keyboardOpen || null}
>
  <div class="flex h-[60px] items-center justify-around px-2">
    {#each navItems as tab (tab.href)}
      {@const active = !inMenu && tab.href === activeNavHref(page.url.pathname)}
      <a
        href={tab.href}
        class="tabbar-item flex h-full flex-1 flex-col items-center justify-center gap-1 rounded-lg"
        class:tabbar-item-active={active}
        aria-current={active ? 'page' : undefined}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={tab.icon} />
        </svg>
        <span
          class="text-[10px] leading-none"
          class:font-semibold={active}
          class:font-medium={!active}
        >
          {tab.label}
        </span>
        {#if active}
          <span
            class="absolute bottom-1 left-1/2 h-[3px] w-1 -translate-x-1/2 rounded-full"
            style="background: var(--color-primary-active);"
            aria-hidden="true"
          ></span>
        {/if}
      </a>
    {/each}

    <!-- Menu « ☰ » : dernier de la barre, à la place qu'occupait Réglages. C'est un
         BOUTON (il ouvre une feuille), pas un lien — mais il s'allume comme un onglet
         quand on est dans l'espace /menu, pour qu'on sache d'où l'on vient. -->
    <button
      type="button"
      onclick={openMenu}
      class="tabbar-item flex h-full flex-1 flex-col items-center justify-center gap-1 rounded-lg"
      class:tabbar-item-active={inMenu || menuSheet.open}
      aria-haspopup="dialog"
      aria-expanded={menuSheet.open}
      aria-label="Menu — réglages et informations techniques"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d={MENU_ICON} />
      </svg>
      <span
        class="text-[10px] leading-none"
        class:font-semibold={inMenu || menuSheet.open}
        class:font-medium={!(inMenu || menuSheet.open)}
      >
        Menu
      </span>
      {#if inMenu}
        <span
          class="absolute bottom-1 left-1/2 h-[3px] w-1 -translate-x-1/2 rounded-full"
          style="background: var(--color-primary-active);"
          aria-hidden="true"
        ></span>
      {/if}
    </button>
  </div>
</nav>

<style>
  /* Promotion sur une couche compositeur dédiée : sans ça, iOS « décroche » les
     éléments `position: fixed` pendant le scroll inertiel (rubber-band) → la
     barre tressaute. translateZ(0) la fige proprement. Sert aussi de base au
     glissement de masquage quand le clavier s'ouvre. */
  .tabbar {
    transform: translateZ(0);
    transition: transform var(--duration-normal) var(--ease-default);
  }
  .tabbar-hidden {
    /* Glisse entièrement sous le bord bas (safe-area comprise) pendant la saisie.
       On conserve translateZ(0) pour garder la couche compositeur pendant la glissade. */
    transform: translateZ(0) translateY(110%);
  }
  @media (prefers-reduced-motion: reduce) {
    .tabbar {
      transition: none;
    }
  }

  .tabbar-item {
    position: relative;
    color: var(--color-muted-fg);
    min-height: 44px;
    /* Le dernier item est un <button> (menu) : sans ça, iOS lui peindrait un fond
       et une bordure natifs au milieu d'une rangée de liens. */
    background: none;
    border: 0;
    -webkit-appearance: none;
    appearance: none;
    transition: color var(--duration-fast) var(--ease-default);
    /* Polish tactile iOS : pas de rectangle gris au tap, pas de zoom double-tap,
       pas de sélection de texte parasite sur un lourd appui. */
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
  }
  .tabbar-item-active {
    color: var(--color-primary-active);
  }
  /* Focus clavier visible (iPad + clavier Bluetooth) ; offset NÉGATIF car
     l'onglet touche le bord bas de l'écran. N'apparaît qu'au clavier
     (:focus-visible) → le polish tactile iOS reste intact. */
  .tabbar-item:focus-visible {
    outline: 2px solid var(--color-primary-active);
    outline-offset: -2px;
    border-radius: var(--radius-lg);
  }
</style>
