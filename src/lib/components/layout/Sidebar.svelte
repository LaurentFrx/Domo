<script lang="ts">
  import { page } from '$app/state';

  interface Item {
    href: string;
    label: string;
    icon: string;
  }

  const items: Item[] = [
    { href: '/', label: 'Accueil', icon: 'M3 11 L12 3 L21 11 V20 H3 Z' },
    { href: '/energie', label: 'Énergie', icon: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z' },
    {
      href: '/pieces',
      label: 'Pièces',
      icon: 'M3 3 H10 V10 H3 Z M14 3 H21 V10 H14 Z M3 14 H10 V21 H3 Z M14 14 H21 V21 H14 Z'
    },
    { href: '/auto', label: 'Auto.', icon: 'M12 2 L13 8 L19 9 L13 11 L12 17 L11 11 L5 9 L11 8 Z' },
    {
      href: '/reglages',
      label: 'Réglages',
      icon: 'M12 2 V4 M12 20 V22 M2 12 H4 M20 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5 M12 8 A4 4 0 1 1 12 16 A4 4 0 1 1 12 8 Z'
    }
  ];

  function isActive(href: string): boolean {
    if (href === '/') return page.url.pathname === '/';
    return page.url.pathname.startsWith(href);
  }
</script>

<aside
  class="safe-top fixed top-0 left-0 z-40 hidden h-screen w-20 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-elevated)] md:flex"
>
  <div class="flex flex-col items-center pt-5 pb-4">
    <span class="text-lg font-medium tracking-tight text-white">Domo</span>
  </div>

  <nav class="flex flex-1 flex-col gap-1 px-2 pt-2">
    {#each items as item (item.href)}
      {@const active = isActive(item.href)}
      <a
        href={item.href}
        class="sidebar-item relative flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 transition-colors"
        class:sidebar-item-active={active}
        aria-current={active ? 'page' : undefined}
      >
        {#if active}
          <span
            class="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-full bg-[var(--accent-500)]"
            aria-hidden="true"
          ></span>
        {/if}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={item.icon} />
        </svg>
        <span class="text-[11px] leading-tight" class:font-semibold={active}>
          {item.label}
        </span>
      </a>
    {/each}
  </nav>
</aside>

<style>
  .sidebar-item {
    color: var(--text-secondary);
  }
  .sidebar-item:hover {
    background-color: var(--surface-card-hover);
    color: var(--text-primary);
  }
  .sidebar-item-active {
    background-color: rgba(110, 69, 255, 0.15);
    color: var(--accent-500);
  }
</style>
