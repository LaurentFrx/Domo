<script lang="ts">
  /**
   * BottomSheet — feuille modale ancrée en bas (iPhone) / centrée (iPad paysage).
   * iOS-safe : verrou de défilement du body (position:fixed + restauration scrollY),
   * zone sûre (safe-area-inset-bottom), -webkit-backdrop-filter, fermeture Escape /
   * tap-outside, focus du panneau, animations gated prefers-reduced-motion, repli
   * opaque sous prefers-reduced-transparency. Porte le verre Yeldra inline.
   */
  import type { Snippet } from 'svelte';

  let {
    open = false,
    title = '',
    onClose,
    children,
    footer
  }: {
    open?: boolean;
    title?: string;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
  } = $props();

  let panelEl = $state<HTMLDivElement | null>(null);

  // Verrou de défilement iOS : fige le body et restaure la position à la fermeture.
  $effect(() => {
    if (typeof document === 'undefined' || !open) return;
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

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
  <!-- Backdrop : fermeture au tap ; le clavier ferme via Escape (svelte:window). -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="bs-overlay" role="presentation" onclick={onClose}>
    <div
      class="bs-panel"
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onclick={(e) => e.stopPropagation()}
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      {#if title}
        <div class="bs-header">
          <span class="bs-title">{title}</span>
          <button type="button" class="bs-close" aria-label="Fermer" onclick={onClose}>×</button>
        </div>
      {/if}
      <div class="bs-body">
        {@render children?.()}
      </div>
      {#if footer}
        <div class="bs-footer">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .bs-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: oklch(0.2 0.02 286 / 0.5);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
  }
  .bs-panel {
    width: 100%;
    max-height: 88vh;
    overflow-y: auto;
    border-width: 1px;
    border-style: solid;
    border-top-left-radius: var(--radius-2xl);
    border-top-right-radius: var(--radius-2xl);
    padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom));
    animation: bs-up 240ms var(--ease-out, cubic-bezier(0.22, 1, 0.36, 1));
  }
  .bs-panel:focus {
    outline: none;
  }
  @media (min-width: 1024px) {
    .bs-overlay {
      align-items: center;
      padding: 1rem;
    }
    .bs-panel {
      max-width: 30rem;
      border-radius: var(--radius-2xl);
      padding-bottom: 1rem;
      animation: bs-fade 200ms ease;
    }
  }
  .bs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .bs-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .bs-close {
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .bs-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .bs-footer {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  @keyframes bs-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  @keyframes bs-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bs-panel {
      animation: none;
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .bs-overlay {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      background: oklch(0.2 0.02 286 / 0.72);
    }
  }
</style>
