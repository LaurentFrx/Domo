<script lang="ts">
  import { page } from '$app/state';
  import { navItems, isActive, type NavItem } from './nav-items';

  interface Section {
    title?: string;
    items: NavItem[];
  }

  // Mêmes entrées que la TabBar (source unique : nav-items.ts), regroupées en
  // deux sections : les 5 premières = « Pilotage », la dernière (Réglages) =
  // « Système ». Le découpage suit l'ordre de navItems.
  const sections: Section[] = [
    { title: 'Pilotage', items: navItems.slice(0, 5) },
    { title: 'Système', items: navItems.slice(5) }
  ];
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
      style="object-fit: cover; box-shadow: var(--shadow-md);"
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
