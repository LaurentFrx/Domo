<script lang="ts">
  // « Fenêtre » repliable des Réglages : un en-tête toujours visible (icône +
  // titre + résumé compact) qui déploie son contenu en douceur. Mécanisme glass
  // hérité via `background: var(--color-card)` (cf. app.css) — ne pas recâbler.
  //
  // Ouverture EXCLUSIVE : toutes les sections partagent `bind:openId` ; ouvrir
  // l'une referme les autres → la page reste courte (une fenêtre à la fois).
  // L'animation de hauteur utilise grid-template-rows 0fr↔1fr (hauteur auto
  // animable, sans JS de mesure) ; l'enfant `.acc-inner` clippe le débordement.
  //
  // L'enfoncement au toucher + le haptique de confirmation viennent du
  // gestionnaire iOS centralisé (`+layout.svelte`) car l'en-tête est un <button>.
  import type { Snippet } from 'svelte';

  interface Props {
    /** Identifiant unique de section (clé d'ouverture exclusive). */
    id: string;
    title: string;
    /** Résumé compact affiché quand la fenêtre est repliée. */
    summary?: string;
    /** Chemin SVG (attribut `d`) tracé sur un viewBox 0 0 24 24. */
    icon: string;
    /** Id de la section ouverte, partagé entre toutes (bindable). */
    openId: string | null;
    children: Snippet;
  }

  let { id, title, summary = '', icon, openId = $bindable(), children }: Props = $props();

  const open = $derived(openId === id);
  const bodyId = $derived(`acc-body-${id}`);

  function toggle() {
    openId = open ? null : id;
  }
</script>

<section
  class="overflow-hidden rounded-[var(--radius-xl)] border"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <button
    type="button"
    onclick={toggle}
    aria-expanded={open}
    aria-controls={bodyId}
    class="acc-head flex w-full items-center gap-3 px-4 py-3.5 text-left"
  >
    <span
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: var(--color-muted); color: var(--color-primary);"
      aria-hidden="true"
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={icon} />
      </svg>
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[14px] font-semibold" style="color: var(--color-fg);">{title}</span>
      {#if summary}
        <span class="truncate text-[11.5px]" style="color: var(--color-muted-fg);">{summary}</span>
      {/if}
    </span>
    <svg
      class="acc-chev shrink-0"
      class:acc-chev-open={open}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-muted-fg)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>

  <div id={bodyId} class="acc-body" class:acc-body-open={open} role="region">
    <!-- `inert` quand replié : contenu clippé (height 0) retiré du tab order + a11y. -->
    <div class="acc-inner" inert={!open}>
      <div class="px-4 pb-4">
        {@render children()}
      </div>
    </div>
  </div>
</section>

<style>
  /* Hauteur animée sans JS : 0fr (replié) ↔ 1fr (déployé, hauteur auto). */
  .acc-body {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--duration-slow) var(--ease-default);
  }
  .acc-body-open {
    grid-template-rows: 1fr;
  }
  /* Indispensable au montage 0fr/1fr : l'enfant doit pouvoir se compresser. */
  .acc-inner {
    overflow: hidden;
    min-height: 0;
  }
  .acc-chev {
    transition: transform var(--duration-slow) var(--ease-default);
  }
  .acc-chev-open {
    transform: rotate(180deg);
  }
  /* Focus clavier visible (iPad + clavier) ; n'apparaît qu'au clavier. */
  .acc-head:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    border-radius: var(--radius-xl);
  }
  @media (prefers-reduced-motion: reduce) {
    .acc-body,
    .acc-chev {
      transition: none;
    }
  }
</style>
