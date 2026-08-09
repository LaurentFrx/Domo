<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import StoreCard from '$components/tiles/StoreCard.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';
  import ZigbeePlugTile from '$components/tiles/ZigbeePlugTile.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ZigbeeGenericTile from '$components/tiles/ZigbeeGenericTile.svelte';
  import PrinterTile from '$components/tiles/PrinterTile.svelte';
  import FindMyCard from '$components/cards/FindMyCard.svelte';
  import WledCard from '$components/cards/WledCard.svelte';
  import { printer } from '$stores/printer.svelte';
  import { matter } from '$stores/matter.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { clock } from '$stores/clock.svelte';
  import { ageLabel } from '$utils/freshness';
  import { findmy } from '$stores/findmy.svelte';
  import { wled } from '$stores/wled.svelte';
  import { acquire } from '$stores/refcount';
  import { haptic } from '$utils/haptic';

  // Stores page-scoped refcountés (cf. $stores/refcount) — partagés avec les pages
  // voisines du pager sans couper le polling au démontage de l'une d'elles.
  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [acquire(matter), acquire(zigbee), acquire(printer), acquire(findmy), acquire(wled)];
  });

  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
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
    for (const sw of matter.commandableSwitches) ensure(sw.room).switches.push(sw);
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
  /**
   * Flux Zigbee muet. Le délai de grâce de 5 min est indispensable : `onerror`
   * passe transitoirement à 'disconnected' à chaque micro-coupure, et sans lui
   * le bandeau clignoterait. `everConnected` évite de l'afficher au chargement.
   *
   * Le HealthBanner global ne couvre PAS ce cas : il surveille la liaison MQTT
   * vue du SERVEUR, avec 3 min de grâce — après un redéploiement, MQTT va très
   * bien, c'est le flux du navigateur qui est mort.
   */
  const zigbeeMuet = $derived(
    zigbee.connectionStatus !== 'connected' &&
      zigbee.everConnected &&
      (zigbee.lastUpdate === null || clock.now - zigbee.lastUpdate.getTime() > 5 * 60_000)
  );
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
  const hasFlatDevices = $derived(matter.commandableSwitches.length + zigbee.devices.length > 0);

  // ─── Vue condensée (Laurent) ───────────────────────────────────────────
  // Ligne 1 : Bureau / Chargeur / Atelier ; Ligne 2 : Imprimante / Portail.
  // On extrait ces appareils par nom/catégorie ; le reste retombe dans les
  // grilles génériques en dessous (sèche-serviette iPad, prises, capteurs…).
  const bureauSwitch = $derived(
    matter.commandableSwitches.find((s) => /multim|bureau/i.test(s.name)) ?? null
  );
  const chargeurSwitch = $derived(
    matter.commandableSwitches.find((s) => /chargeur|charger/i.test(s.name)) ?? null
  );
  // ─── Spot de la terrasse ───────────────────────────────────────────────
  // Il rejoint le ruban WLED dans la carte « Terrasse » (LEDS + Spot) : les
  // deux lumières d'un même lieu se commandent au même endroit. Il est donc
  // RETIRÉ de la grille générique plus bas, sinon il s'y afficherait en double.
  // Reconnu par son NOM (nom + pièce), pas par son nodeId : celui-ci est
  // attribué à la commission et n'est pas connu d'avance. Le nom vient de
  // SWITCH_NAMES si le device y figure, sinon de son NodeLabel Matter — donc
  // le nommer « Spot » à la commission suffit, sans toucher au code. La pièce,
  // elle, n'existe que dans SWITCH_NAMES : le premier test (nom ET pièce) ne
  // passe qu'une fois l'entrée ajoutée, le second suffit d'ici là.
  const terraceSpot = $derived(
    matter.commandableSwitches.find(
      (s) => /spot/i.test(`${s.name} ${s.room}`) && /terrasse/i.test(`${s.name} ${s.room}`)
    ) ??
      matter.commandableSwitches.find((s) => /spot/i.test(s.name)) ??
      null
  );
  const restSwitches = $derived(
    matter.commandableSwitches.filter(
      (s) => s !== bureauSwitch && s !== chargeurSwitch && s !== terraceSpot
    )
  );
  const atelierDevice = $derived(
    flatZigbeeOthers.find(
      (d) => d.category === 'light' || /atelier|lumiere|lumière|lampe/i.test(d.friendlyName)
    ) ?? null
  );
  const portailDevice = $derived(
    flatZigbeeOthers.find((d) => d.category === 'cover' || /portail|porte/i.test(d.friendlyName)) ??
      null
  );
  const restOthers = $derived(
    flatZigbeeOthers.filter((d) => d !== atelierDevice && d !== portailDevice)
  );

  // ─── Tri custom des volets (ordre choisi par Laurent) ───
  const SHUTTER_ORDER = [
    'salon',
    'salle à manger',
    'cuisine',
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

<div class="flex flex-col gap-2 py-3">
  {#if matter.commandError}
    <!-- Une commande refusée était jusqu'ici totalement muette : l'animation
         optimiste et le retour haptique de confirmation faisaient croire au
         succès pendant que le volet ne bougeait pas. -->
    <div
      class="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] px-4 py-3 text-[13px]"
      style="background: var(--color-alert-muted); color: var(--color-alert);"
      role="alert"
    >
      <span>{matter.commandError}</span>
      <button
        type="button"
        onclick={() => (matter.commandError = null)}
        class="shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-semibold"
        style="background: var(--color-card); color: var(--color-fg);"
      >
        OK
      </button>
    </div>
  {/if}
  {#if zigbeeMuet}
    <div
      class="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] px-4 py-3 text-[13px]"
      style="background: var(--color-alert-muted); color: var(--color-alert);"
      role="status"
    >
      <span>
        <strong>Capteurs et prises : plus de nouvelles.</strong>
        Les valeurs affichées datent{zigbee.lastUpdate
          ? ` d'il y a ${ageLabel(clock.now - zigbee.lastUpdate.getTime())}`
          : ''}, et les commandes peuvent ne pas partir. La reconnexion se fait toute seule.
      </span>
      <button
        type="button"
        onclick={() => zigbee.reconnect()}
        class="shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-semibold"
        style="background: var(--color-card); color: var(--color-fg);"
      >
        Réessayer
      </button>
    </div>
  {/if}
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

    <!-- ═══ Vue condensée — Ligne 1 : Bureau / Chargeur / Atelier / Portail ═══ -->
    <!-- 4 commandes sur une seule ligne : ce sont les mêmes gestes (un appui, un
         état), elles se lisent d'un coup d'œil. Les libellés sont déjà tronqués
         proprement dans les tuiles (`truncate`), ce qui tient sur un iPhone étroit. -->
    {#if bureauSwitch || chargeurSwitch || atelierDevice || portailDevice}
      <div class="grid grid-cols-4 gap-2.5 sm:gap-3">
        {#if bureauSwitch}<SwitchTile sw={bureauSwitch} />{/if}
        {#if chargeurSwitch}<SwitchTile sw={chargeurSwitch} />{/if}
        {#if atelierDevice}<ZigbeeGenericTile device={atelierDevice} />{/if}
        {#if portailDevice}<ZigbeeGenericTile device={portailDevice} />{/if}
      </div>
    {/if}

    <!-- ═══ Reste : sèche-serviette (iPad), autres switches/lumières Zigbee ═══ -->
    {#if restSwitches.length > 0 || restOthers.length > 0}
      <div class="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {#each restSwitches as sw (sw.nodeId)}
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
        {#each restOthers as device (device.ieee)}
          <ZigbeeGenericTile {device} />
        {/each}
      </div>
    {/if}

    <!-- ═══ Prises / capteurs Zigbee (hors imprimante) — pleine largeur sur iPhone ═══ -->
    {#if flatZigbeePlugs.length + flatZigbeeSensors.length > 0}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each flatZigbeePlugs as device (device.ieee)}
          <ZigbeePlugTile {device} />
        {/each}
        {#each flatZigbeeSensors as device (device.ieee)}
          <ZigbeeSensorTile {device} />
        {/each}
      </div>
    {/if}
  {/if}

  <!-- ═══ Terrasse — LEDS (WLED, QuinLed Dig-Uno) + Spot (Matter). Le ruban est
       indépendant de Matter, la carte reste donc HORS du bloc conditionnel
       ci-dessus (toujours visible) ; la rangée Spot, elle, n'apparaît que si le
       spot est appairé. ═══ -->
  <WledCard spot={terraceSpot} />

  <!-- ═══ Imprimante — descendue sous l'éclairage terrasse : on la consulte
       (niveaux d'encre), on ne la commande pas au quotidien. Elle sort du bloc
       conditionnel Matter au passage, ce qui est CORRECT : c'est une prise Zigbee,
       elle n'a jamais eu de raison de disparaître quand le hub Matter décroche. ═══ -->
  {#if printerPlug}
    <PrinterTile plug={printerPlug} />
  {/if}

  <!-- ═══ Appareils Apple « Localiser » (findmy-bridge → MQTT) — bas de page ═══ -->
  <FindMyCard />
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
    gap: 0.375rem;
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

  /* Carte store : pleine largeur sur iPhone, largeur bornée sur iPad+
     (barre + 3 boutons sur une ligne → besoin de plus de place qu'avant). */
  @media (min-width: 640px) {
    .store-wrap {
      max-width: 340px;
    }
  }
</style>
