<script lang="ts">
  import { onMount } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import VoletGroupActions from '$components/tiles/VoletGroupActions.svelte';

  // Mêmes nœuds que la page Pièces.
  const VOLET_NODES: readonly number[] = [2, 3, 4, 5, 6, 7, 12, 13];

  // Connexion idempotente : si la page Pièces a déjà connecté, ce sera un no-op.
  onMount(() => {
    matter.connect();
  });

  const onlineCount = $derived(VOLET_NODES.filter((id) => matter.isAvailable(id)).length);
  const total = VOLET_NODES.length;
</script>

<div
  class="flex flex-col gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
>
  <a
    href="/pieces"
    class="-m-1 flex items-center justify-between rounded-lg p-1 transition-colors hover:bg-white/5"
  >
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">VOLETS</span>
    <div class="flex items-center gap-1.5">
      <span
        class="h-2 w-2 rounded-full"
        style:background-color={onlineCount > 0 ? 'var(--accent-500)' : 'var(--text-secondary)'}
      ></span>
      <span class="text-xs font-medium text-white">{onlineCount}/{total} en ligne</span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        class="ml-1 text-[var(--text-secondary)]"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </div>
  </a>

  <VoletGroupActions nodeIds={[...VOLET_NODES]} variant="compact" />
</div>
