<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';
  import ZigbeePlugTile from '$components/tiles/ZigbeePlugTile.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ZigbeeGenericTile from '$components/tiles/ZigbeeGenericTile.svelte';
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

  // ─── Filtres d'affichage Zigbee sur cette page ─────────────────────────
  // Les thermomètres (Thermo SdB / Salon / Garage / cumulus / ext / velos)
  // sont déplacés sur /climat. Frigo + Lave-linge déplacés sur /energie
  // (suivi conso électroménager). Cette liste est carrément retirée.
  const HIDDEN_ZIGBEE = new Set([
    'chargeur isa', // plus en fonctionnement
    'chargeur laurent', // remplacé par Matter
    'ordi moniteur', // remplacé par Matter
    'frigo', // affiché sur /energie
    'lave-linge', // affiché sur /energie
    'lave_vaisselle' // affiché sur /energie
  ]);
  function isHidden(name: string): boolean {
    return HIDDEN_ZIGBEE.has(name.toLowerCase());
  }
  const flatZigbeeSensors = $derived(
    zigbee.devices.filter(
      (d) =>
        d.category === 'sensor' &&
        !d.friendlyName.toLowerCase().includes('thermo') &&
        !isHidden(d.friendlyName)
    )
  );
  const flatZigbeePlugs = $derived(
    zigbee.devices.filter((d) => d.category === 'plug' && !isHidden(d.friendlyName))
  );
  const flatZigbeeOthers = $derived(
    zigbee.devices.filter(
      (d) => !['sensor', 'plug'].includes(d.category) && !isHidden(d.friendlyName)
    )
  );
  const hasFlatDevices = $derived(
    matter.switches.length + zigbee.devices.length > 0
  );

  // ─── Tri custom des volets (ordre choisi par Laurent) ───
  const SHUTTER_ORDER = [
    'salon',
    'salle à manger',
    'balcon',
    'bureau',
    'chambre parents',
    'chambre amis'
  ];
  function shutterOrderIdx(name: string): number {
    const lower = name.toLowerCase();
    const idx = SHUTTER_ORDER.findIndex((s) => lower.includes(s));
    return idx === -1 ? 999 : idx;
  }
  const sortedShutters = $derived(
    [...matter.shutters].sort(
      (a, b) => shutterOrderIdx(a.name) - shutterOrderIdx(b.name)
    )
  );
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 py-4">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold tracking-tight">Pièces</h1>
    <div class="flex flex-wrap items-center gap-2">
      <!-- Pills sources Matter + Zigbee : toujours visibles, à droite du titre -->
      <span
        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px]"
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
        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px]"
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
  </header>

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
    <!-- ═══ Strip 'Tous les volets' — visible partout (3 cols mobile, N sur lg+) ═══ -->
    {#if matter.shutters.length > 0}
      <section
        class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-center justify-between gap-3">
          <h2
            class="text-[11px] font-semibold tracking-[0.08em] uppercase"
            style="color: var(--color-muted-fg);"
          >
            Volets · {matter.shutters.length}
          </h2>
          {#if matterConnected && matter.onlineCount > 0}
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
        </div>
        <div
          class="shutters-strip"
          style="--shutter-count: {sortedShutters.length};"
        >
          {#each sortedShutters as shutter (shutter.nodeId)}
            <ShutterTile {shutter} />
          {/each}
        </div>
      </section>
    {/if}

    <!-- ═══ Grille FLAT switches/zigbee — 1 par ligne sur iPhone, plus dense ailleurs ═══ -->
    {#if hasFlatDevices}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each matter.switches as sw (sw.nodeId)}
          <SwitchTile {sw} />
        {/each}
        {#each flatZigbeePlugs as device (device.ieee)}
          <ZigbeePlugTile {device} />
        {/each}
        {#each flatZigbeeOthers as device (device.ieee)}
          <ZigbeeGenericTile {device} />
        {/each}
        {#each flatZigbeeSensors as device (device.ieee)}
          <ZigbeeSensorTile {device} />
        {/each}
      </div>
    {/if}
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

  /* Strip 'Volets' : 3 cols sur mobile (= 3 + 3 sur 2 lignes pour 6 volets),
     auto-fit en sm-lg (peut wrap), force N cols sur lg+ (1 seule ligne sur iPad+). */
  .shutters-strip {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  @media (min-width: 640px) {
    .shutters-strip {
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }
  }
  @media (min-width: 1024px) {
    .shutters-strip {
      grid-template-columns: repeat(var(--shutter-count, 6), minmax(0, 1fr));
    }
  }
</style>
