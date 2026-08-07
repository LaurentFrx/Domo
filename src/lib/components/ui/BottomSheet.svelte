<script lang="ts">
  /**
   * Feuille modale ancrée en HAUT (iPhone) / centrée (iPad paysage).
   *
   * Ancrée en bas jusqu'au 04/08/2026 : sur iPhone, une feuille longue posée en
   * bas d'écran laissait ses premiers réglages hors de portée du pouce, et le
   * bas du panneau se retrouvait sous la barre d'onglets. Elle descend donc
   * désormais du haut — le titre et la croix de fermeture arrivent là où le
   * regard est déjà. Le nom du composant est resté `BottomSheet` : il est
   * importé par plusieurs écrans, le renommer est un chantier à part.
   *
   * Architecture de défilement : le PANNEAU est un cadre qui ne défile pas
   * (flex column, overflow hidden) ; seul `.bs-body` défile. Trois raisons,
   * toutes iOS : (1) un overflow clippe au PADDING BOX — si le panneau était
   * le scroller, le contenu défilé resterait visible dans le padding de zone
   * sûre et passerait sous la Dynamic Island ; (2) l'en-tête (titre + croix)
   * et le pied (boutons d'action) restent atteignables même feuille défilée ;
   * (3) la zone morte sous la barre d'outils de Safari ne peut plus avaler le
   * pied : c'est le corps qui se comprime, et il défile.
   *
   * iOS-safe : verrou de défilement du body (position:fixed + restauration
   * scrollY), zones sûres HAUTE (encoche / Dynamic Island) et LATÉRALES
   * (paysage), hauteur en dvh (le vh de Safari inclut la barre d'URL),
   * -webkit-backdrop-filter, fermeture Escape / tap-outside / navigation
   * (afterNavigate — retour matériel, lien profond), focus piégé dans la
   * feuille et rendu à l'ouvreur à la fermeture, animations gated
   * prefers-reduced-motion, repli opaque sous prefers-reduced-transparency.
   * Porte le verre Yeldra inline.
   */
  import type { Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';

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

  // Filet : une navigation déclenchée autrement qu'au tap (retour matériel,
  // edge-swipe Safari, ⌘[ sur iPad clavier, lien profond) ne doit pas laisser
  // la feuille ouverte par-dessus la nouvelle page — d'autant que le verrou de
  // défilement restaurerait ensuite le scroll de l'ANCIENNE page sur la
  // nouvelle. Même filet que MenuSheet ; le pushState d'un swipe du Pager ne
  // déclenche pas afterNavigate, aucun effet de bord.
  afterNavigate(() => {
    if (open) onClose();
  });

  // Verrou de défilement iOS : fige le body et restaure la position à la
  // fermeture — et rend le focus à l'élément qui a ouvert la feuille (sinon il
  // tombe sur body : au clavier, on repart de zéro à chaque fermeture).
  $effect(() => {
    if (typeof document === 'undefined' || !open) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      opener?.focus?.();
    };
  });

  /**
   * Piège Tab dans la feuille : `aria-modal` ne rend PAS le fond inerte pour
   * le clavier — sans ce piège, Tab s'échappe vers la Sidebar/TabBar derrière
   * l'overlay et Entrée active un lien invisible (navigation sous la modale).
   */
  function trapTab(e: KeyboardEvent) {
    if (!panelEl) return;
    const focusables = panelEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) {
      e.preventDefault();
      panelEl.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && panelEl.contains(active);
    if (
      e.shiftKey ? active === first || active === panelEl || !inside : active === last || !inside
    ) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Tab') trapTab(e);
  }
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
  <!-- Backdrop : fermeture au tap ; le clavier ferme via Escape (svelte:window). -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <!-- data-no-ptr : l'overlay est role="presentation", donc invisible au test
       [role="dialog"] du tirer-pour-rafraîchir. Même intention que
       data-swipe-ignore pour le Pager. -->
  <div class="bs-overlay" role="presentation" data-swipe-ignore data-no-ptr onclick={onClose}>
    <div
      class="bs-panel"
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onclick={(e) => e.stopPropagation()}
      style="background: linear-gradient(var(--color-card), var(--color-card)), var(--color-bg); border-color: var(--color-border);"
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
    align-items: flex-start;
    justify-content: center;
    background: oklch(0.2 0.02 286 / 0.5);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
  }
  .bs-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    /* dvh : ancrée en HAUT, une hauteur en vh (qui inclut la barre d'URL
       dynamique de Safari) ferait déborder le bas de la feuille sous l'écran
       visible. Le vh reste en repli pour les moteurs sans dvh. */
    max-height: 88vh;
    max-height: 88dvh;
    /* Le panneau NE défile PAS (cf. doc d'en-tête) : c'est .bs-body qui
       défile, l'en-tête et le pied restent en place. */
    overflow: hidden;
    border-width: 1px;
    border-style: solid;
    border-bottom-left-radius: var(--radius-2xl);
    border-bottom-right-radius: var(--radius-2xl);
    /* Zones sûres : HAUT (encoche / Dynamic Island en portrait) et CÔTÉS
       (encoche passée sur un flanc en paysage iPhone — rien ne verrouille
       l'orientation, iOS ignore le membre `orientation` du manifest). */
    padding: calc(1rem + env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 1rem
      max(1rem, env(safe-area-inset-left));
    animation: bs-down 240ms var(--ease-out, cubic-bezier(0.22, 1, 0.36, 1));
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
      /* Centrée : plus aucune arête ne touche un bord d'écran, la zone sûre
         n'a plus lieu d'être. */
      padding: 1rem;
      animation: bs-fade 200ms ease;
    }
  }
  .bs-header {
    display: flex;
    flex-shrink: 0;
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
    position: relative;
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
  /* Zone tappable 44×44 (HIG) sans grossir le rendu : c'est LE bouton de
     sortie, un tap raté sur 32 px est avalé par le stopPropagation du panneau. */
  .bs-close::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .bs-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    /* LE scroller de la feuille (cf. doc d'en-tête). min-height: 0 : sans lui,
       un flex item refuse de rétrécir sous sa hauteur de contenu. */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .bs-footer {
    display: flex;
    flex-shrink: 0;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  @keyframes bs-down {
    from {
      transform: translateY(-100%);
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
