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

  function isActive(href: string): boolean {
    if (href === '/') return page.url.pathname === '/';
    return page.url.pathname.startsWith(href);
  }
</script>

<nav
  class="fixed right-0 bottom-0 left-0 z-50 border-t sm:hidden"
  style="
    background: var(--color-bg);
    border-color: var(--color-border);
    padding-bottom: env(safe-area-inset-bottom);
    height: calc(60px + env(safe-area-inset-bottom));
  "
  aria-label="Navigation principale"
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
  .tabbar-item {
    position: relative;
    color: var(--color-muted-fg);
    min-height: 44px;
    transition: color var(--duration-fast) var(--ease-default);
  }
  .tabbar-item-active {
    color: var(--color-primary);
  }
</style>
