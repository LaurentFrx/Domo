<script lang="ts">
  import { page } from '$app/state';

  interface Tab {
    href: string;
    label: string;
    icon: string;
  }

  const tabs: Tab[] = [
    { href: '/', label: 'Accueil', icon: 'M3 11 L12 3 L21 11 V20 H3 Z' },
    { href: '/energie', label: 'Énergie', icon: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z' },
    {
      href: '/climat',
      label: 'Climat',
      icon: 'M12 2 C12 2 8 6 8 12 C8 16 10 19 12 19 C14 19 16 16 16 12 C16 8 14 6 14 6 C14 8 13 10 12 10 C11 10 12 6 12 2 Z'
    },
    {
      href: '/pieces',
      label: 'Pièces',
      icon: 'M3 3 H10 V10 H3 Z M14 3 H21 V10 H14 Z M3 14 H10 V21 H3 Z M14 14 H21 V21 H14 Z'
    },
    {
      href: '/maison',
      label: 'Maison',
      icon: 'M12 2 L21 7 V17 L12 22 L3 17 V7 Z M3 7 L12 12 L21 7 M12 12 V22'
    },
    {
      href: '/reglages',
      label: 'Réglages',
      icon: 'M12 8 A4 4 0 1 1 12 16 A4 4 0 1 1 12 8 Z M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.5 4.5 L6.5 6.5 M17.5 17.5 L19.5 19.5 M4.5 19.5 L6.5 17.5 M17.5 6.5 L19.5 4.5'
    }
  ];

  // Suivi du lien actif — comparaison par SEGMENT et non par simple préfixe de
  // chaîne : `startsWith('/maison')` allumerait aussi un hypothétique
  // `/maisonnette`, alors que `/reglages` doit bien rester actif sur
  // `/reglages/planning`. On exige donc l'égalité OU un préfixe suivi d'un « / ».
  function isActive(href: string): boolean {
    const path = page.url.pathname;
    if (href === '/') return path === '/';
    return path === href || path.startsWith(href + '/');
  }

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
  $effect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (opensKeyboard(e.target)) keyboardOpen = true;
    };
    const onFocusOut = () => {
      keyboardOpen = false;
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
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
  aria-hidden={keyboardOpen}
>
  <div class="flex h-[60px] items-center justify-around px-2">
    {#each tabs as tab (tab.href)}
      {@const active = isActive(tab.href)}
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
            class="absolute -bottom-0.5 h-[3px] w-1 rounded-full"
            style="background: var(--color-primary);"
            aria-hidden="true"
          ></span>
        {/if}
      </a>
    {/each}
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
    /* Glisse entièrement sous le bord bas (safe-area comprise) pendant la saisie. */
    transform: translateY(110%);
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
    transition: color var(--duration-fast) var(--ease-default);
    /* Polish tactile iOS : pas de rectangle gris au tap, pas de zoom double-tap,
       pas de sélection de texte parasite sur un lourd appui. */
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
  }
  .tabbar-item-active {
    color: var(--color-primary);
  }
</style>
