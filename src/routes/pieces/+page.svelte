<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Header from '$components/layout/Header.svelte';
  import VoletTile from '$components/tiles/VoletTile.svelte';
  import VoletGroupActions from '$components/tiles/VoletGroupActions.svelte';
  import { matter } from '$stores/matter.svelte';

  // Nœuds volets identifiés (cf. inventaire Matter — node 1 = smart plug, ignoré).
  const VOLET_NODES: readonly number[] = [2, 3, 4, 5, 6, 7, 12, 13];

  onMount(() => {
    matter.connect();
  });

  onDestroy(() => {
    matter.disconnect();
  });

  const statusLabel = $derived(
    matter.connected ? 'Connecté' : matter.reconnecting ? 'Reconnexion…' : 'Déconnecté'
  );

  const statusColor = $derived(
    matter.connected
      ? 'var(--accent-500)'
      : matter.reconnecting
        ? 'var(--warning)'
        : 'var(--text-secondary)'
  );
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 pb-6">
  <Header name="Pièces" />

  <!-- Statut connexion Matter -->
  <div
    class="flex items-center gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-2.5"
  >
    <span
      class="h-2 w-2 rounded-full transition-colors"
      class:animate-pulse={matter.reconnecting}
      style:background-color={statusColor}
    ></span>
    <span class="text-xs text-[var(--text-secondary)]">Matter</span>
    <span class="text-xs font-medium text-white">{statusLabel}</span>
  </div>

  <!-- Actions groupées -->
  <VoletGroupActions nodeIds={[...VOLET_NODES]} />

  <!-- Grille des volets -->
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    {#each VOLET_NODES as nodeId (nodeId)}
      <VoletTile {nodeId} />
    {/each}
  </div>
</div>
