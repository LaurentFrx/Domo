<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import RoomSection from '$components/tiles/RoomSection.svelte';
  import { matter } from '$stores/matter.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';

  onMount(() => {
    matter.connect();
    zigbee.connect();
  });

  onDestroy(() => {
    matter.disconnect();
    zigbee.disconnect();
  });

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

  function zigbeeColor(status: string): string {
    if (status === 'connected') return 'var(--color-battery)';
    if (status === 'unconfigured') return 'var(--color-muted-fg)';
    return 'var(--color-warning)';
  }
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 py-4">
  <header class="flex items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold tracking-tight">Pièces</h1>
    {#if matterConnected && hasShutters && matter.onlineCount > 0}
      <div class="flex gap-2">
        <button
          type="button"
          class="pill-open"
          onclick={() => { haptic('heavy'); matter.openAll(); }}
          aria-label="Ouvrir tous les volets"
        >
          <span aria-hidden="true">▲</span> Tout ouvrir
        </button>
        <button
          type="button"
          class="pill-close"
          onclick={() => { haptic('heavy'); matter.closeAll(); }}
          aria-label="Fermer tous les volets"
        >
          <span aria-hidden="true">▼</span> Tout fermer
        </button>
      </div>
    {/if}
  </header>

  <!-- Sources status -->
  <div class="flex flex-wrap gap-2 text-[10px]">
    <span
      class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5"
      style="
        border-color: var(--color-border);
        color: {matterConnected ? 'var(--color-battery)' : 'var(--color-muted-fg)'};
      "
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style:background-color={matterConnected ? 'var(--color-battery)' : 'var(--color-muted-fg)'}
      ></span>
      Matter
    </span>
    <span
      class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5"
      style="
        border-color: var(--color-border);
        color: {zigbeeColor(zigbee.connectionStatus)};
      "
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style:background-color={zigbeeColor(zigbee.connectionStatus)}
      ></span>
      Zigbee · {zigbee.devices.length}
    </span>
  </div>

  {#if matterDisconnected}
    <div
      class="rounded-[var(--radius-2xl)] border p-6 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="text-sm" style="color: var(--color-muted-fg);">
        Connexion au serveur Matter perdue
      </p>
      <button
        type="button"
        class="mt-3 rounded-full px-4 py-2 text-xs font-semibold"
        style="background: var(--color-primary); color: var(--color-primary-fg);"
        onclick={() => matter.connect()}
      >
        Reconnecter
      </button>
    </div>
  {:else if matter.connectionStatus === 'connecting' && mergedRooms.length === 0}
    <div
      class="rounded-[var(--radius-2xl)] border p-6 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="text-sm" style="color: var(--color-muted-fg);">Connexion en cours…</p>
    </div>
  {:else if isEmpty}
    <div
      class="rounded-[var(--radius-2xl)] border p-6 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="text-sm" style="color: var(--color-muted-fg);">Aucun appareil détecté</p>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
  .pill-open,
  .pill-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    border: 1px solid transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .pill-open {
    color: var(--color-battery);
    background: var(--color-battery-muted);
    border-color: var(--color-battery);
  }
  .pill-open:hover {
    background: var(--color-battery);
    color: var(--color-primary-fg);
  }
  .pill-close {
    color: var(--color-primary);
    background: var(--color-primary-muted);
    border-color: var(--color-primary);
  }
  .pill-close:hover {
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .pill-open:active,
  .pill-close:active {
    transform: scale(0.97);
  }
</style>
