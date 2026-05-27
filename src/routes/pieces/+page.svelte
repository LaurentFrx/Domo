<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import RoomSection from '$components/tiles/RoomSection.svelte';
  import { matter } from '$stores/matter.svelte';
  import { formatDate } from '$utils/format';

  onMount(() => {
    matter.connect();
  });

  onDestroy(() => {
    matter.disconnect();
  });

  const date = $derived(formatDate());
  const hasShutters = $derived(matter.shutters.length > 0);
  const isConnected = $derived(matter.connectionStatus === 'connected');
  const isDisconnected = $derived(matter.connectionStatus === 'disconnected');
  const isEmpty = $derived(matter.rooms.length === 0 && isConnected);
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 pb-6">
  <!-- Header : date + titre + actions globales volets -->
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-medium text-white">Pièces</h1>
      {#if isConnected && hasShutters && matter.onlineCount > 0}
        <div class="flex gap-2">
          <button
            type="button"
            class="pill-accent"
            onclick={() => matter.openAll()}
            aria-label="Ouvrir tous les volets"
          >
            <span aria-hidden="true">▲</span> Tous les volets
          </button>
          <button
            type="button"
            class="pill-primary"
            onclick={() => matter.closeAll()}
            aria-label="Fermer tous les volets"
          >
            <span aria-hidden="true">▼</span> Tous les volets
          </button>
        </div>
      {/if}
    </div>
  </header>

  {#if isDisconnected}
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
  {:else if matter.connectionStatus === 'connecting'}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center"
    >
      <p class="text-sm text-[var(--text-secondary)]">Connexion au serveur Matter…</p>
    </div>
  {:else if isEmpty}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center"
    >
      <p class="text-sm text-[var(--text-secondary)]">Aucun appareil détecté</p>
    </div>
  {:else}
    <div class="stagger-enter grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
      {#each matter.rooms as room (room.room)}
        <RoomSection {room} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Pills d'actions globales : accent vert pour ouvrir, primary violet pour
     fermer. Glass moins prononcé que dans la version précédente, pour
     rester cohérent avec les pills internes des sections pièce. */
  .pill-accent,
  .pill-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--motion-fast) var(--easing-default),
      box-shadow var(--motion-fast) var(--easing-default),
      transform var(--motion-fast) var(--easing-default);
  }

  .pill-accent {
    color: var(--surface-base);
    background: var(--accent-500);
    box-shadow: 0 0 18px rgba(61, 253, 152, 0.25);
  }

  .pill-accent:hover {
    background: var(--accent-600);
    box-shadow: 0 0 24px rgba(61, 253, 152, 0.4);
  }

  .pill-primary {
    color: var(--text-primary);
    background: var(--primary-500);
    box-shadow: 0 0 18px rgba(110, 69, 255, 0.25);
  }

  .pill-primary:hover {
    background: var(--primary-600);
    box-shadow: 0 0 24px rgba(110, 69, 255, 0.4);
  }

  .pill-accent:active,
  .pill-primary:active {
    transform: scale(0.96);
  }
</style>
