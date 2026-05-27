<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';
  import { matter } from '$stores/matter.svelte';
  import { formatDate } from '$utils/format';

  onMount(() => {
    matter.connect();
  });

  onDestroy(() => {
    matter.disconnect();
  });

  const date = $derived(formatDate());

  const shuttersByRoom = $derived.by(() => {
    const grouped = new Map<string, typeof matter.shutters>();
    for (const s of matter.shutters) {
      const list = grouped.get(s.room) || [];
      list.push(s);
      grouped.set(s.room, list);
    }
    return grouped;
  });
</script>

<svelte:head>
  <title>Volets — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 pb-6">
  <!-- Header inline : date + titre « Volets » + actions globales sur la même ligne -->
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-medium text-white">Volets</h1>
      {#if matter.connectionStatus === 'connected' && matter.onlineCount > 0}
        <div class="flex gap-2">
          <button type="button" class="pill-glass" onclick={() => matter.openAll()}>
            Tout ouvrir
          </button>
          <button type="button" class="pill-glass" onclick={() => matter.closeAll()}>
            Tout fermer
          </button>
        </div>
      {/if}
    </div>
  </header>

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

  {#if matter.switches.length > 0}
    <div class="flex flex-col gap-2">
      <h2 class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">INTERRUPTEURS</h2>
      <div class="grid grid-cols-2 gap-2">
        {#each matter.switches as sw (sw.nodeId)}
          <SwitchTile {sw} />
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Pills glassmorphism : transparence + backdrop blur, cohérent avec
     l'esthétique glass des ShutterTile. */
  .pill-glass {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    backdrop-filter: blur(14px) saturate(160%);
    -webkit-backdrop-filter: blur(14px) saturate(160%);
    box-shadow:
      0 4px 12px rgba(0, 0, 0, 0.25),
      inset 0 1px 0 rgba(255, 255, 255, 0.07);
    transition:
      background-color var(--motion-fast) var(--easing-default),
      border-color var(--motion-fast) var(--easing-default),
      box-shadow var(--motion-fast) var(--easing-default);
    cursor: pointer;
  }

  .pill-glass:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.2);
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.3),
      0 0 18px rgba(61, 253, 152, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .pill-glass:active {
    background: rgba(255, 255, 255, 0.2);
  }
</style>
