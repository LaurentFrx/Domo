<script lang="ts">
  import { page } from '$app/state';

  interface Tab {
    href: string;
    label: string;
    icon: string; // path SVG simplifié
  }

  const tabs: Tab[] = [
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

<nav
  class="safe-bottom tabbar-glass fixed right-0 bottom-0 left-0 z-50 border-t border-white/[0.08] px-3 pt-2 pb-3 md:hidden"
>
  <div class="flex items-center justify-around">
    {#each tabs as tab (tab.href)}
      {@const active = isActive(tab.href)}
      <a
        href={tab.href}
        class="flex flex-1 flex-col items-center gap-0.5 transition-colors"
        style="color: {active ? 'var(--accent-500)' : 'var(--text-secondary)'};"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d={tab.icon} />
        </svg>
        <span class="text-[10px]" class:font-semibold={active}>
          {tab.label}
        </span>
      </a>
    {/each}
  </div>
</nav>

<style>
  .tabbar-glass {
    background-color: color-mix(in oklab, var(--surface-base) 90%, transparent);
    backdrop-filter: blur(12px) saturate(160%);
    -webkit-backdrop-filter: blur(12px) saturate(160%);
  }
</style>
