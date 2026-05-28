<svelte:head>
  <title>Accès restreint — Domo</title>
</svelte:head>

<div class="flex min-h-[100dvh] items-center justify-center px-4">
  <div
    class="pointer-events-none fixed top-1/3 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full opacity-15 blur-3xl"
    style="background: radial-gradient(circle, var(--primary-500) 0%, transparent 70%);"
  ></div>

  <div class="relative flex flex-col items-center gap-6 text-center">
    <div
      class="flex h-16 w-16 items-center justify-center rounded-2xl"
      style="background: linear-gradient(135deg, var(--primary-500), var(--primary-600));"
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        stroke-width="1.5"
        stroke-linecap="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </div>

    <div class="flex flex-col gap-2">
      <h1 class="text-xl font-medium text-white">Accès restreint</h1>
      <p class="max-w-xs text-sm text-[var(--text-secondary)]">
        Cette application est réservée à la famille. Demande le lien d'accès à Laurent.
      </p>
    </div>
  </div>
</div>
