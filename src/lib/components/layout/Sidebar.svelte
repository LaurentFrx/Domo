<script lang="ts">
  import { page } from '$app/state';
  import { navItems, isActive, type NavItem } from './nav-items';
  import { MENU_ICON, isMenuDestination } from './menu-items';
  import { menuSheet, openMenu } from './menu-state.svelte';

  interface Section {
    title?: string;
    items: NavItem[];
  }

  // Mêmes entrées que la TabBar (source unique : nav-items.ts). Il ne reste qu'une
  // section : la navigation ne porte plus que le pilotage quotidien — réglages et
  // technique sont passés derrière le bouton « ☰ » du pied de barre.
  const sections: Section[] = [{ title: 'Pilotage', items: navItems }];

  const inMenu = $derived(isMenuDestination(page.url.pathname));
</script>

<aside
  class="safe-top fixed top-0 left-0 z-40 hidden h-screen w-[72px] flex-col border-r sm:flex lg:w-[280px]"
  style="background: var(--color-sidebar); color: var(--color-sidebar-fg); border-color: oklch(0.25 0.015 280);"
  aria-label="Navigation principale"
>
  <!-- Branding -->
  <div class="flex h-14 items-center justify-center px-5 lg:justify-start lg:gap-2.5">
    <img
      src="/icons/apple-touch-icon.png"
      alt="Domo"
      width="32"
      height="32"
      class="h-8 w-8 rounded-lg"
      style="object-fit: cover;"
    />
    <span class="hidden text-base font-semibold tracking-tight lg:inline"> Domo </span>
  </div>

  <nav class="flex flex-1 flex-col gap-4 px-2 pt-3 pb-4 lg:px-3">
    {#each sections as section (section.title)}
      <div class="flex flex-col gap-0.5">
        {#if section.title}
          <span
            class="hidden px-3 pt-2 pb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase lg:block"
            style="color: var(--color-sidebar-muted);"
          >
            {section.title}
          </span>
        {/if}
        {#each section.items as item (item.href)}
          {@const active = isActive(page.url.pathname, item.href)}
          <a
            href={item.href}
            class="sidebar-item relative flex items-center justify-center rounded-md transition-colors lg:justify-start lg:gap-3"
            class:sidebar-item-active={active}
            aria-current={active ? 'page' : undefined}
            title={item.label}
          >
            {#if active}
              <span
                class="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-full lg:left-[-12px]"
                style="background: var(--color-sidebar-active-border);"
                aria-hidden="true"
              ></span>
            {/if}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              class="shrink-0"
            >
              <path d={item.icon} />
            </svg>
            <span class="hidden text-[13px] lg:inline">{item.label}</span>
          </a>
        {/each}
      </div>
    {/each}

    <!-- Menu « ☰ » : même feuille que sur iPhone (centrée sur grand écran). Poussé
         en bas de la colonne — c'est le tiroir, pas une destination de pilotage. -->
    <button
      type="button"
      onclick={openMenu}
      class="sidebar-item sidebar-menu relative mt-auto flex items-center justify-center rounded-md transition-colors lg:justify-start lg:gap-3"
      class:sidebar-item-active={inMenu || menuSheet.open}
      aria-haspopup="dialog"
      aria-expanded={menuSheet.open}
      title="Menu — réglages et informations techniques"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        aria-hidden="true"
        class="shrink-0"
      >
        <path d={MENU_ICON} />
      </svg>
      <span class="hidden text-[13px] lg:inline">Menu</span>
    </button>
  </nav>

  <!-- User footer -->
  <div
    class="hidden border-t px-4 py-3 lg:flex lg:items-center lg:gap-2.5"
    style="border-color: oklch(0.25 0.015 280);"
  >
    <span
      class="inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold"
      style="background: var(--color-sidebar-accent); color: var(--color-sidebar-fg);"
      aria-hidden="true"
    >
      LF
    </span>
    <div class="flex flex-col leading-tight">
      <span class="text-[12px] font-semibold">Laurent Feroux</span>
      <span class="text-[11px]" style="color: var(--color-sidebar-muted);"> domo.feroux.fr </span>
    </div>
  </div>
</aside>

<style>
  .sidebar-item {
    padding: 8px;
    color: var(--color-sidebar-muted);
    height: 36px;
  }
  @media (min-width: 1024px) {
    .sidebar-item {
      padding: 8px 12px;
    }
  }
  /* Le pied de barre est un <button> au milieu de liens : on neutralise le rendu
     natif pour qu'il soit visuellement indiscernable d'un item de navigation. */
  .sidebar-menu {
    width: 100%;
    background: none;
    border: 0;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .sidebar-item:hover {
    background: var(--color-sidebar-hover);
    color: var(--color-sidebar-fg);
  }
  .sidebar-item-active {
    background: var(--color-sidebar-active);
    color: var(--color-sidebar-fg);
    font-weight: 600;
  }
  /* Focus clavier visible (iPad + clavier Bluetooth) ; n'apparaît qu'au clavier. */
  .sidebar-item:focus-visible {
    outline: 2px solid var(--color-sidebar-active-border);
    outline-offset: 2px;
  }
</style>
