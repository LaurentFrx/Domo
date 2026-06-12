<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import StoreCard from '$components/tiles/StoreCard.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';
  import ZigbeePlugTile from '$components/tiles/ZigbeePlugTile.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ZigbeeGenericTile from '$components/tiles/ZigbeeGenericTile.svelte';
  import PrinterTile from '$components/tiles/PrinterTile.svelte';
  import { printer } from '$stores/printer.svelte';
  import { matter } from '$stores/matter.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';

  onMount(() => {
    matter.connect();
    zigbee.connect();
    printer.connect();
  });

  onDestroy(() => {
    matter.disconnect();
    zigbee.disconnect();
    printer.disconnect();
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
  // « Connexion perdue » = déconnecté APRÈS avoir été connecté (vraie coupure).
  // Tant qu'on n'a jamais abouti (état initial, montage), c'est « en cours », pas
  // une erreur → supprime le flash du message au chargement de la page.
  const matterLost = $derived(matter.connectionStatus === 'disconnected' && matter.everConnected);
  const matterPending = $derived(
    matter.connectionStatus === 'connecting' ||
      (matter.connectionStatus === 'disconnected' && !matter.everConnected)
  );
  const isEmpty = $derived(
    mergedRooms.length === 0 &&
      matterConnected &&
      ['connected', 'unconfigured'].includes(zigbee.connectionStatus)
  );

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
    'lave_vaisselle', // affiché sur /energie
    'prise libre' // sans usage pour l'instant — à remettre au besoin
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
    zigbee.devices.filter(
      (d) =>
        d.category === 'plug' &&
        !isHidden(d.friendlyName) &&
        d.friendlyName.toLowerCase() !== 'imprimante epson'
    )
  );
  // La prise Imprimante Epson est extraite à part pour la PrinterTile
  // (toggle prise + niveaux d'encre scrappés).
  const printerPlug = $derived(
    zigbee.devices.find((d) => d.friendlyName.toLowerCase() === 'imprimante epson') ?? null
  );
  const flatZigbeeOthers = $derived(
    zigbee.devices.filter(
      (d) => !['sensor', 'plug'].includes(d.category) && !isHidden(d.friendlyName)
    )
  );
  const hasFlatDevices = $derived(matter.switches.length + zigbee.devices.length > 0);

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
    [...matter.shutters].sort((a, b) => shutterOrderIdx(a.name) - shutterOrderIdx(b.name))
  );
  // Le store-banne (libellés d'extrêmes Rentré/Déployé) est séparé des volets
  // roulants : les 6 volets dans une seule carte, le store dans sa carte dédiée.
  const rollerShutters = $derived(sortedShutters.filter((s) => s.labelMin === undefined));
  const storeShutter = $derived(sortedShutters.find((s) => s.labelMin !== undefined) ?? null);
</script>

<svelte:head>
  <title>Pièces — Domo</title>
</svelte:head>

<div class="flex flex-col gap-4 py-4">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Pièces</h1>
  </header>

  {#if matterLost}
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
  {:else if matterPending && mergedRooms.length === 0}
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
    <!-- ═══ Volets roulants — tuiles posées directement sur la page (pas de carte
         englobante ni de titre) ; boutons globaux à droite, dès l'iPad. ═══ -->
    {#if rollerShutters.length > 0}
      <div class="flex flex-col gap-2">
        {#if matterConnected && matter.onlineCount > 0}
          <!-- Boutons globaux masqués sur iPhone (place compacte) — visibles dès iPad. -->
          <div class="hidden justify-end gap-2 sm:flex">
            <button
              type="button"
              class="pill-open"
              onclick={() => {
                haptic('heavy');
                matter.openAll();
              }}
              aria-label="Ouvrir tous les volets"
            >
              <span aria-hidden="true">▲</span> Tout ouvrir
            </button>
            <button
              type="button"
              class="pill-close"
              onclick={() => {
                haptic('heavy');
                matter.closeAll();
              }}
              aria-label="Fermer tous les volets"
            >
              <span aria-hidden="true">▼</span> Tout fermer
            </button>
          </div>
        {/if}
        <div class="shutters-strip" style="--shutter-count: {rollerShutters.length};">
          {#each rollerShutters as shutter (shutter.nodeId)}
            <ShutterTile {shutter} />
          {/each}
        </div>
      </div>
    {/if}

    <!-- ═══ Store-banne — commande dédiée, à part des volets roulants ═══ -->
    {#if storeShutter}
      <div class="store-wrap">
        <StoreCard shutter={storeShutter} />
      </div>
    {/if}

    <!-- ═══ Interrupteurs (switches Matter + portail / lumières Zigbee) — tuiles
         icône + nom, colorées vives quand ON, sans toggle ; grille 2 col sur iPhone ═══ -->
    {#if matter.switches.length > 0 || flatZigbeeOthers.length > 0}
      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {#each matter.switches as sw (sw.nodeId)}
          {#if sw.nodeId === 1}
            <!-- Sèche-serviette : doublon avec la carte « Salle de bain » (/climat) +
                 piloté par le daemon → masqué sur iPhone, gardé sur iPad/desktop. -->
            <div class="hidden sm:block">
              <SwitchTile {sw} />
            </div>
          {:else}
            <SwitchTile {sw} />
          {/if}
        {/each}
        {#each flatZigbeeOthers as device (device.ieee)}
          <ZigbeeGenericTile {device} />
        {/each}
      </div>
    {/if}

    <!-- ═══ Prises / capteurs / imprimante Zigbee — pleine largeur sur iPhone ═══ -->
    {#if printerPlug || flatZigbeePlugs.length + flatZigbeeSensors.length > 0}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#if printerPlug}
          <PrinterTile plug={printerPlug} />
        {/if}
        {#each flatZigbeePlugs as device (device.ieee)}
          <ZigbeePlugTile {device} />
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

  /* Volets : tuiles-cartes posées directement sur la page (pas de conteneur).
     iPhone : 1 colonne de rangées horizontales (chaque volet = sa propre carte) ;
     iPad+ : grille (auto-fit, puis N colonnes pleine ligne dès lg). */
  .shutters-strip {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: 1fr;
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

  /* Carte store : pleine largeur sur iPhone (design banne), compacte sur iPad+. */
  @media (min-width: 640px) {
    .store-wrap {
      max-width: 220px;
    }
  }
</style>
