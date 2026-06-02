<script lang="ts">
  import { page } from '$app/state';

  interface Item {
    href: string;
    label: string;
    icon: string;
  }

  interface Section {
    title?: string;
    items: Item[];
  }

  const ICON = {
    home: 'M3 11 L12 3 L21 11 V20 H3 Z',
    zap: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z',
    flame:
      'M12 2 C12 2 8 6 8 12 C8 16 10 19 12 19 C14 19 16 16 16 12 C16 8 14 6 14 6 C14 8 13 10 12 10 C11 10 12 6 12 2 Z',
    grid: 'M3 3 H10 V10 H3 Z M14 3 H21 V10 H14 Z M3 14 H10 V21 H3 Z M14 14 H21 V21 H14 Z',
    settings:
      'M12 8 A4 4 0 1 1 12 16 A4 4 0 1 1 12 8 Z M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.5 4.5 L6.5 6.5 M17.5 17.5 L19.5 19.5 M4.5 19.5 L6.5 17.5 M17.5 6.5 L19.5 4.5'
  } as const;

  const sections: Section[] = [
    {
      title: 'Pilotage',
      items: [
        { href: '/', label: 'Accueil', icon: ICON.home },
        { href: '/energie', label: 'Énergie', icon: ICON.zap },
        { href: '/climat', label: 'Climat', icon: ICON.flame },
        { href: '/pieces', label: 'Pièces', icon: ICON.grid }
      ]
    },
    {
      title: 'Système',
      items: [{ href: '/reglages', label: 'Réglages', icon: ICON.settings }]
    }
  ];

  function isActive(href: string): boolean {
    if (href === '/') return page.url.pathname === '/';
    return page.url.pathname.startsWith(href);
  }
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
          {@const active = isActive(item.href)}
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
</style>
