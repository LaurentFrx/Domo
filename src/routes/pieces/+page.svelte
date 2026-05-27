<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import RoomSection from '$components/tiles/RoomSection.svelte';
  import { matter } from '$stores/matter.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { formatDate } from '$utils/format';

  onMount(() => {
    matter.connect();
    zigbee.connect();
  });

  onDestroy(() => {
    matter.disconnect();
    zigbee.disconnect();
  });

  const date = $derived(formatDate());

  // ─── Fusion Matter + Zigbee par pièce ──────────────────────────────────
  const mergedRooms = $derived.by(() => {
    const map = new Map<
      string,
      {
        room: string;
        shutters: typeof matter.shutters;
        switches: typeof matter.switches;
        zigbeeDevices: typeof zigbee.devices;
      }
    >();
    const ensure = (r: string) => {
      let g = map.get(r);
      if (!g) {
        g = { room: r, shutters: [], switches: [], zigbeeDevices: [] };
        map.set(r, g);
      }
      return g;
    };
    for (const s of matter.shutters) ensure(s.room).shutters.push(s);
    for (const sw of matter.switches) ensure(sw.room).switches.push(sw);
    for (const d of zigbee.devices) ensure(d.room).zigbeeDevices.push(d);
    return [...map.values()].sort((a, b) => {
      const ca = a.shutters.length + a.switches.length + a.zigbeeDevices.length;
      const cb = b.shutters.length + b.switches.length + b.zigbeeDevices.length;
      if (ca !== cb) return cb - ca;
      return a.room.localeCompare(b.room, 'fr');
    });
  });

  const hasShutters = $derived(matter.shutters.length > 0);
  const matterConnected = $derived(matter.connectionStatus === 'connected');
  const matterDisconnected = $derived(matter.connectionStatus === 'disconnected');
  const isEmpty = $derived(
    mergedRooms.length === 0 &&
      matterConnected &&
      ['connected', 'unconfigured'].includes(zigbee.connectionStatus)
  );
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 pb-6">
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-medium text-white">Pièces</h1>
      {#if matterConnected && hasShutters && matter.onlineCount > 0}
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

  <!-- Sources status -->
  <div class="flex flex-wrap gap-2 text-[10px]">
    <span
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2 py-0.5"
      style:color={matterConnected ? 'var(--accent-500)' : 'var(--text-tertiary)'}
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style:background-color={matterConnected ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      ></span>
      Matter
    </span>
    <span
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2 py-0.5"
      style:color={zigbee.connectionStatus === 'connected'
        ? 'var(--accent-500)'
        : zigbee.connectionStatus === 'unconfigured'
          ? 'var(--text-tertiary)'
          : 'var(--warning)'}
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style:background-color={zigbee.connectionStatus === 'connected'
          ? 'var(--accent-500)'
          : zigbee.connectionStatus === 'unconfigured'
            ? 'var(--text-tertiary)'
            : 'var(--warning)'}
      ></span>
      Zigbee · {zigbee.devices.length}
    </span>
  </div>

  {#if matterDisconnected}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center shadow-[var(--shadow-card)]"
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
  {:else if matter.connectionStatus === 'connecting' && mergedRooms.length === 0}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center shadow-[var(--shadow-card)]"
    >
      <p class="text-sm text-[var(--text-secondary)]">Connexion en cours…</p>
    </div>
  {:else if isEmpty}
    <div
      class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center shadow-[var(--shadow-card)]"
    >
      <p class="text-sm text-[var(--text-secondary)]">Aucun appareil détecté</p>
    </div>
  {:else}
    <div class="stagger-enter grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
      {#each mergedRooms as r (r.room)}
        <RoomSection
          room={r.room}
          shutters={r.shutters}
          switches={r.switches}
          zigbeeDevices={r.zigbeeDevices}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
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
