<script lang="ts">
  import ConcentricRings from '$components/effects/ConcentricRings.svelte';
</script>

<svelte:head>
  <title>Accès restreint — Domo</title>
</svelte:head>

<div
  class="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-4"
  style="background: var(--color-bg);"
>
  <!-- Anneaux orbitaux (vert OVNI) centrés derrière la carte d'accès -->
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    <ConcentricRings />
  </div>

  <div class="relative z-[1] flex max-w-sm flex-col items-center gap-6 text-center">
    <div
      class="flex h-16 w-16 items-center justify-center rounded-2xl"
      style="background: var(--color-primary-muted); color: var(--color-primary);"
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>

    <div class="flex flex-col gap-2">
      <h1 class="text-[20px] font-semibold tracking-tight" style="color: var(--color-fg);">
        Accès restreint
      </h1>
      <p class="text-[14px]" style="color: var(--color-muted-fg);">
        Cette application est réservée à la famille. Demande le lien d'accès à Laurent.
      </p>
      <a
        href="mailto:laurent@feroux.fr?subject=Demande%20d%27acc%C3%A8s%20Domo&body=Bonjour%20Laurent%2C%20peux-tu%20m%27envoyer%20le%20lien%20d%27acc%C3%A8s%20%C3%A0%20Domo%20%3F"
        class="inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-semibold transition-transform active:scale-95"
        style="background: var(--color-primary); color: white;"
      >
        Demander l'accès
      </a>
    </div>
  </div>
</div>
