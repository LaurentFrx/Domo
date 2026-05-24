<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Header from '$components/layout/Header.svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import { matter } from '$stores/matter.svelte';

  onMount(() => {
    matter.connect();
  });

  onDestroy(() => {
    matter.disconnect();
  });

  const shuttersByRoom = $derived.by(() => {
    const grouped = new Map<string, typeof matter.shutters>();
    for (const s of matter.shutters) {
      const list = grouped.get(s.room) || [];
      list.push(s);
      grouped.set(s.room, list);
    }
    return grouped;
  });

  const statusLabel = $derived(
    matter.connectionStatus === 'connected'
      ? `${matter.onlineCount}/${matter.shutters.length} en ligne`
      : matter.connectionStatus === 'connecting'
        ? 'Connexion…'
        : 'Déconnecté'
  );

  const statusColor = $derived(
    matter.connectionStatus === 'connected'
      ? 'var(--accent-500)'
      : matter.connectionStatus === 'connecting'
        ? 'var(--warning)'
        : 'var(--error)'
  );
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 pb-6">
  <Header name="Pièces" />

  <!-- Status bar -->
  <div
    class="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3"
  >
    <div class="flex items-center gap-2">
      <span
        class="h-2 w-2 rounded-full"
        class:animate-pulse={matter.connectionStatus === 'connecting'}
        style="background-color: {statusColor};"
      ></span>
      <span class="text-xs text-[var(--text-secondary)]">
        Matter · {statusLabel}
      </span>
    </div>

    <!-- Global actions -->
    {#if matter.connectionStatus === 'connected' && matter.onlineCount > 0}
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded-full border border-[var(--border-subtle)] bg-white/5 px-3 py-1 text-[10px] font-medium text-white transition-colors hover:bg-white/10"
          onclick={() => matter.openAll()}
        >
          Tout ouvrir
        </button>
        <button
          type="button"
          class="rounded-full border border-[var(--border-subtle)] bg-white/5 px-3 py-1 text-[10px] font-medium text-white transition-colors hover:bg-white/10"
          onclick={() => matter.closeAll()}
        >
          Tout fermer
        </button>
      </div>
    {/if}
  </div>

  <!-- Shutters grouped by room -->
  {#if matter.shutters.length === 0 && matter.connectionStatus === 'connected'}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center"
    >
      <p class="text-sm text-[var(--text-secondary)]">Aucun volet détecté</p>
    </div>
  {:else if matter.connectionStatus === 'disconnected'}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center"
    >
      <p class="text-sm text-[var(--text-secondary)]">Connexion au serveur Matter perdue</p>
      <button
        type="button"
        class="mt-3 rounded-full bg-[var(--primary-500)] px-4 py-2 text-xs font-medium text-white"
        onclick={() => matter.connect()}
      >
        Reconnecter
      </button>
    </div>
  {:else}
    {#each [...shuttersByRoom] as [room, shutters] (room)}
      <div class="flex flex-col gap-2">
        <h2 class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
          {room.toUpperCase()}
        </h2>
        <div class="grid grid-cols-2 gap-2">
          {#each shutters as shutter (shutter.nodeId)}
            <ShutterTile {shutter} />
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
