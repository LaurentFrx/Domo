<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ShuttersCard from '$components/tiles/ShuttersCard.svelte';
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

  /**
   * `page` : la mise en page de /pieces. `column` : une pile, pour la colonne
   * « Pièces » de /bureau — les grilles internes se déplient sur la largeur du
   * VIEWPORT, pas sur celle de la colonne.
   */
  let { layout = 'page' }: { layout?: 'page' | 'column' } = $props();
  const column = $derived(layout === 'column');

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
  // Il prend place sur la LIGNE DES COMMANDES RAPIDES, avec Bureau / Chargeur /
  // Atelier / Portail : ce sont les mêmes gestes (un appui, un état), on les
  // veut tous à portée de pouce au même endroit. Il est donc RETIRÉ de la
  // grille générique plus bas, sinon il s'y afficherait en double.
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
  // Colonnes de la ligne rapide : autant que de tuiles réellement présentes —
  // une classe Tailwind fixe laisserait un trou (spot non appairé) ou ferait
  // déborder la 5ᵉ tuile sur une seconde ligne.
  const quickTiles = $derived(
    [bureauSwitch, chargeurSwitch, atelierDevice, terraceSpot, portailDevice].filter(Boolean).length
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

<div class="flex flex-col gap-2 py-3" class:rooms-col={column}>
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
    <!-- ═══ Volets roulants — UNE carte pour les 7 (rangées d'une ligne sur iPhone,
         grille de sliders dès l'iPad ; boutons globaux en tête dès l'iPad). ═══ -->
    {#if rollerShutters.length > 0}
      <ShuttersCard
        shutters={rollerShutters}
        showGlobal={matterConnected && matter.onlineCount > 0}
      />
    {/if}

    <!-- Dès l'iPad : le store-banne (image + 2 boutons, borné à 340 px) tient la
         colonne de gauche sur TOUTE la hauteur du bloc, et les commandes —
         raccourcis, sèche-serviette, prises et capteurs — s'empilent à sa droite.
         Avant, chacune de ces trois listes posait sa propre ligne pleine largeur :
         le store laissait 500 px de vide à sa droite, le sèche-serviette 700.
         `contents` = sur iPhone, ce groupe n'existe pas. -->
    <div
      class={column
        ? 'flex flex-col gap-3'
        : 'pad:grid pad:grid-cols-[340px_minmax(0,1fr)] pad:items-start pad:gap-3 contents'}
    >
      <!-- ═══ Store-banne — commande dédiée, à part des volets roulants ═══ -->
      {#if storeShutter}
        <div class="store-wrap" class:pad:row-span-3={!column} class:store-col={column}>
          <StoreCard shutter={storeShutter} />
        </div>
      {/if}

      <!-- ═══ Interrupteurs — Bureau / Chargeur / Atelier / Spot / Portail, puis
           le reste (sèche-serviette…) ═══
           Dès l'iPad : UNE carte, en puces de 44 px (18/09/2026). Chaque commande
           « un appui, un état » était une carte de 64 px à elle seule — cinq cartes
           pour cinq boutons, 200 px de colonne au tableau de bord.
           Sur iPhone la carte n'existe pas (`contents`) : la ligne de tuiles et la
           grille du reste retombent dans le flux, telles qu'avant. Le même montage
           sert aux deux (pas de `hidden`/`pad:hidden`) ; les tuiles savent qu'elles
           sont groupées (`grouped`) et ne changent de gabarit qu'avec la carte. -->
      {#if quickTiles > 0 || restSwitches.length > 0 || restOthers.length > 0}
        <div
          class="pad:grid pad:grid-cols-[repeat(auto-fit,minmax(108px,1fr))] pad:gap-1.5 pad:rounded-[var(--radius-xl)] pad:border pad:p-2 contents min-w-0"
          style="background: var(--color-card); border-color: var(--color-border);"
          aria-label="Interrupteurs"
        >
          {#if quickTiles > 0}
            <!-- iPhone : une ligne de N tuiles (N = tuiles réellement présentes —
                 une classe fixe laisserait un trou ou ferait déborder la 5ᵉ). -->
            <div
              class="pad:contents grid min-w-0 grid-cols-[repeat(var(--qt),minmax(0,1fr))] gap-2.5 sm:gap-3"
              style="--qt: {quickTiles};"
            >
              {#if bureauSwitch}<SwitchTile sw={bureauSwitch} grouped />{/if}
              {#if chargeurSwitch}<SwitchTile sw={chargeurSwitch} grouped />{/if}
              {#if atelierDevice}<ZigbeeGenericTile device={atelierDevice} grouped />{/if}
              {#if terraceSpot}<SwitchTile sw={terraceSpot} grouped />{/if}
              {#if portailDevice}<ZigbeeGenericTile device={portailDevice} grouped />{/if}
            </div>
          {/if}

          {#if restSwitches.length > 0 || restOthers.length > 0}
            <div class="pad:contents grid min-w-0 grid-cols-2 gap-2.5 sm:gap-3">
              {#each restSwitches as sw (sw.nodeId)}
                {#if sw.nodeId === 1}
                  <!-- Sèche-serviette : doublon avec la carte « Salle de bain » (/climat) +
                       piloté par le daemon → masqué sur iPhone, gardé sur iPad/desktop. -->
                  <div class="hidden min-w-0 sm:block">
                    <SwitchTile {sw} grouped />
                  </div>
                {:else}
                  <SwitchTile {sw} grouped />
                {/if}
              {/each}
              {#each restOthers as device (device.ieee)}
                <ZigbeeGenericTile {device} grouped />
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ═══ Prises / capteurs Zigbee (hors imprimante) ═══ -->
      {#if flatZigbeePlugs.length + flatZigbeeSensors.length > 0}
        <div
          class={column
            ? 'grid min-w-0 grid-cols-2 gap-3'
            : 'pad:grid-cols-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'}
        >
          {#each flatZigbeePlugs as device (device.ieee)}
            <ZigbeePlugTile {device} />
          {/each}
          {#each flatZigbeeSensors as device (device.ieee)}
            <ZigbeeSensorTile {device} />
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Terrasse et imprimante se partagent la ligne dès l'iPad : deux cartes que
       l'on CONSULTE, aucune des deux n'a besoin de 1 100 px. -->
  <div
    class={column
      ? 'flex flex-col gap-3'
      : 'pad:grid pad:grid-cols-2 pad:items-start pad:gap-3 contents'}
  >
    <!-- ═══ Terrasse — le ruban LEDS (WLED, QuinLed Dig-Uno). Indépendant de
         Matter, la carte reste donc HORS du bloc conditionnel ci-dessus (toujours
         visible). Le spot, lui, est monté sur la ligne des commandes rapides. ═══ -->
    <WledCard />

    <!-- ═══ Imprimante — descendue sous l'éclairage terrasse : on la consulte
         (niveaux d'encre), on ne la commande pas au quotidien. Elle sort du bloc
         conditionnel Matter au passage, ce qui est CORRECT : c'est une prise Zigbee,
         elle n'a jamais eu de raison de disparaître quand le hub Matter décroche. ═══ -->
    {#if printerPlug}
      <PrinterTile plug={printerPlug} />
    {/if}
  </div>

  <!-- ═══ Appareils Apple « Localiser » (findmy-bridge → MQTT) — bas de page ═══ -->
  <FindMyCard />
</div>

<style>
  /* Carte store : pleine largeur sur iPhone, largeur bornée sur iPad+
     (barre + 3 boutons sur une ligne → besoin de plus de place qu'avant). */
  @media (min-width: 640px) {
    .store-wrap {
      max-width: 340px;
    }
  }

  /* ─── Colonne étroite (/bureau) ────────────────────────────────────────
     Le volet de bureau mesure 24 (curseur) + 12 (gap) + 60 (bouton) = 96 px ;
     la colonne n'en donne que 80 à chacun des sept. On reprend le gabarit
     COMPACT du composant (celui de l'iPhone : boutons de 44) — mesuré, pas
     deviné : 20 + 12 + 44 = 76 px. En dessous, les boutons passeraient sous la
     cible tactile de 44 px. Le nom suit : « Chambre » ne tient pas à 13 px. */
  .rooms-col :global(.shutter-tile) {
    --ssize: 16px;
    container-type: inline-size;
  }
  /* Le volet se taille sur SA tuile, pas sur un seuil d'écran. Mesuré : il lui
     faut la piste (16) + l'écart (6) + les marges (4) avant le bouton — d'où
     `100cqw - 26px`. Sans ça, les boutons sortaient de leur tuile dès que la
     fenêtre passait sous 2 400 px (3 px à 2 200, 9 px à 1 900) : invisible de
     près, mais c'est ce qui empilait les curseurs sur un portable mis à
     l'échelle. Plancher 24 px (cible de clic à la souris), plafond 44 (le
     gabarit tactile d'origine, atteint dès 2 400 px de fenêtre).
     Les variables sont posées sur le CORPS et non sur la tuile : les unités de
     conteneur se résolvent sur un ANCÊTRE, jamais sur l'élément qui les porte. */
  .rooms-col :global(.shutter-body) {
    --bsize: clamp(24px, calc(100cqw - 26px), 44px);
    --body-h: calc(3 * var(--bsize) + 12px);
  }
  /* Le volet de bureau ajoute 12 px de marge intérieure de chaque côté et
     12 px entre le curseur et les boutons : 24 + 16 + 12 + 44 = 96 px, pour
     73 px de colonne. On resserre marge et écart — le bouton, lui, reste à
     44 px (cible de clic), c'est la seule cote qu'on ne touche pas. */
  .rooms-col :global(.shutter-tile > div:first-child) {
    padding: 6px 2px 4px;
  }
  .rooms-col :global(.shutter-body) {
    gap: 6px;
  }
  /* Le nom suit la largeur réelle de la tuile : « Chambre » doit tenir entier,
     que la colonne fasse 563 px (27 pouces) ou 432 (portable mis à l'échelle).
     Bornes mesurées — en dessous de 10 px le mot devient illisible à 80 cm. */
  .rooms-col :global(.shutter-tile) {
    container-type: inline-size;
  }
  .rooms-col :global(.shutter-name) {
    font-size: clamp(10px, 21cqw, 11.5px);
  }
  /* En colonne (/bureau) : la carte store n'a plus de voisin à sa droite. */
  .store-wrap.store-col {
    max-width: none;
  }
</style>
