<script lang="ts">
  /**
   * Pochette d'album via le proxy /api/plex/image, avec REPLI dégradé
   * déterministe (teinte dérivée du titre → stable entre rendus) + note de
   * musique, pour les albums sans artwork ou en erreur de chargement.
   */
  import { plexImg } from '$stores/plex.svelte';

  let {
    thumb = null,
    title = '',
    size = 300,
    radius = 18
  }: { thumb?: string | null; title?: string; size?: number; radius?: number } = $props();

  let failed = $state(false);
  const url = $derived(plexImg(thumb, size));

  // Accents lumineux de la charte (jamais l'ocre banni) — indexés par le titre.
  const HUES = [60, 128, 152, 200, 262, 293, 350];
  const hue = $derived(
    HUES[[...title].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % HUES.length]
  );
</script>

{#if url && !failed}
  <img
    src={url}
    alt=""
    loading="lazy"
    decoding="async"
    onerror={() => (failed = true)}
    class="cover"
    style="border-radius: {radius}px;"
  />
{:else}
  <div
    class="cover fallback"
    style="
      border-radius: {radius}px;
      background: linear-gradient(135deg, oklch(0.75 0.19 {hue}), oklch(0.42 0.14 {(hue + 70) %
      360}));
    "
    aria-hidden="true"
  >
    <svg
      width="34%"
      height="34%"
      viewBox="0 0 24 24"
      fill="none"
      stroke="oklch(0.98 0.01 286 / 0.85)"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 18 V5 L21 3 V16" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  </div>
{/if}

<style>
  .cover {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border: 1px solid var(--color-border);
  }
  .fallback {
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
