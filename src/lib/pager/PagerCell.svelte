<script lang="ts">
  /**
   * Cellule d'aperçu du pager : monte le VRAI composant de page d'une voisine
   * (via le registre lazy) pour qu'on voie son contenu défiler pendant le glissé.
   *
   * Cas /maison : on NE monte PAS la 3D en aperçu (un seul contexte WebGL, réservé
   * à la page centrale) → repère léger icône + nom. La vraie 3D s'affiche au commit
   * (la route devient courante, rendue par le routeur).
   *
   * Le composant de page acquiert ses stores au montage (refcount, cf.
   * $stores/refcount) → polling partagé, pas de duplication.
   */
  import type { Component } from 'svelte';
  import { loaderFor } from '$lib/pager/page-registry';
  import { navItems } from '$components/layout/nav-items';

  let { href, active = false }: { href: string; active?: boolean } = $props();

  const item = $derived(navItems.find((n) => n.href === href) ?? null);
  // /maison : la 3D (WebGL) n'est montée QUE quand la cellule est centrale (active).
  // En voisine → repère léger, pour ne garder qu'UN seul contexte WebGL vivant.
  const useSplash = $derived(href === '/maison' && !active);

  let Comp = $state<Component | null>(null);
  $effect(() => {
    if (useSplash) return; // pas de chargement tant qu'on affiche le repère
    let cancelled = false;
    Comp = null;
    loaderFor(href)?.().then((m) => {
      if (!cancelled) Comp = m.default;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if useSplash}
  <div class="pc-splash">
    <span class="pc-splash-icon" aria-hidden="true">
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={item?.icon} />
      </svg>
    </span>
    <span class="pc-splash-label">{item?.label ?? 'Maison'}</span>
  </div>
{:else if Comp}
  <Comp />
{/if}

<style>
  .pc-splash {
    display: flex;
    min-height: 60vh;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
  }
  .pc-splash-icon {
    display: inline-flex;
    height: 64px;
    width: 64px;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-2xl);
    background: var(--color-card-hover);
    border: 1px solid var(--color-border);
    color: var(--color-primary);
  }
  .pc-splash-label {
    font-size: 17px;
    font-weight: 600;
    color: var(--color-fg);
  }
</style>
