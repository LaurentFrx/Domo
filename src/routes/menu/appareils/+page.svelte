<script lang="ts">
  /**
   * Rubrique « Appareils & capteurs » — l'état des LIAISONS (qui répond, dans quel
   * mode, depuis quand) et les niveaux de PILES, regroupés depuis toute l'app.
   *
   * Présentation façon « Réglages > Wi-Fi » : listes sans icône, libellé à gauche,
   * valeur secondaire à droite (verte si tout va bien, rouge si la source est
   * muette). Les stores sont refcountés : /climat, /pieces… peuvent être montées
   * en même temps par le pager, un connect/disconnect binaire couperait l'autre.
   */
  import { onMount, onDestroy } from 'svelte';
  import { anker } from '$stores/anker.svelte';
  import { matter } from '$stores/matter.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import { airzone } from '$stores/airzone.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { acquire, acquireFns } from '$stores/refcount';
  import { clock } from '$stores/clock.svelte';

  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [
      acquire(matter),
      acquire(daikin),
      acquire(weather),
      acquire(zigbee),
      acquire(airzone),
      acquire(forecast),
      acquire(thermostat),
      acquireFns(
        'cumulus:relay',
        () => cumulus.connectRelay(),
        () => cumulus.disconnectRelay()
      )
    ];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });

  type Conn = {
    name: string;
    connected: boolean;
    mode: string;
    lastUpdate: Date | null;
    devices?: number;
  };

  const connections = $derived<Conn[]>([
    {
      name: 'Anker Solix',
      connected: anker.connected,
      mode: anker.status === 'connected' ? 'Cloud' : 'Hors ligne',
      lastUpdate: anker.lastUpdate,
      devices: anker.batteries.length
    },
    {
      name: 'Matter',
      connected: matter.connectionStatus === 'connected',
      mode: matter.connectionStatus === 'connected' ? 'Local' : 'Hors ligne',
      lastUpdate: null,
      devices: matter.shutters.length + matter.switches.length
    },
    {
      name: 'Daikin Onecta',
      connected: daikin.connected,
      mode: daikin.connected ? 'Cloud' : 'Hors ligne',
      lastUpdate: daikin.lastUpdate,
      devices: daikin.units.length
    },
    {
      name: 'Airzone',
      connected: airzone.connected,
      mode: airzone.connected ? 'Local' : 'Hors ligne',
      lastUpdate: airzone.lastUpdate,
      devices: airzone.zones.length
    },
    {
      name: 'Prévision solaire',
      connected: forecast.status === 'live',
      mode:
        forecast.status === 'live'
          ? 'Local'
          : forecast.status === 'error'
            ? 'Hors ligne'
            : 'Connexion…',
      lastUpdate: null
    },
    {
      name: 'Météo',
      connected: weather.connected,
      mode: weather.connected ? 'Cloud' : 'Hors ligne',
      lastUpdate: weather.lastUpdate
    },
    {
      name: 'Zigbee',
      connected: zigbee.connectionStatus === 'connected',
      mode: zigbee.connectionStatus === 'connected' ? 'Local' : 'Hors ligne',
      lastUpdate: null,
      devices: zigbee.devices.length
    },
    {
      name: 'Relais chauffe-eau',
      connected: cumulus.relayConnected,
      mode: cumulus.relayConnected ? 'Local' : 'Hors ligne',
      lastUpdate: cumulus.relayConnected ? cumulus.lastUpdate : null
    },
    {
      name: 'Thermostat salle de bain',
      connected: thermostat.connected,
      mode: thermostat.connected ? 'Local' : 'Hors ligne',
      lastUpdate: thermostat.connected ? thermostat.lastUpdate : null
    }
  ]);

  const upCount = $derived(connections.filter((c) => c.connected).length);

  // `clock.now` (horloge partagée du layout) : sans elle, « il y a 4 min » se
  // figerait à la valeur du premier rendu.
  function fmtAge(d: Date | null): string {
    if (!d) return '';
    const sec = Math.round((clock.now - d.getTime()) / 1000);
    if (sec < 60) return `il y a ${sec} s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `il y a ${min} min`;
    return `il y a ${Math.round(min / 60)} h`;
  }

  function subFor(c: Conn): string {
    const bits = [];
    if (c.devices !== undefined) bits.push(`${c.devices} appareil${c.devices > 1 ? 's' : ''}`);
    const age = fmtAge(c.lastUpdate);
    if (age) bits.push(age);
    return bits.join(' · ');
  }

  // ─── Piles : capteurs Zigbee + thermostats de zone Airzone, le plus faible
  // en tête. Les appareils Apple gardent leur propre carte (page Pièces).
  const batteryItems = $derived(
    [
      ...zigbee.devices
        .filter((d) => Number.isFinite(d.state.battery))
        .map((d) => ({
          name: d.friendlyName,
          pct: Math.round(d.state.battery as number),
          coverage: null as number | null
        })),
      ...airzone.zones
        .filter((z) => z.battery !== null)
        .map((z) => ({ name: z.name, pct: z.battery as number, coverage: z.coverage }))
    ].sort((a, b) => a.pct - b.pct)
  );
  function battClass(pct: number): string {
    return pct > 50 ? '' : pct > 20 ? 'is-orange' : 'is-red';
  }
</script>

<section class="ios-section">
  <h2 class="ios-group-header">Liaisons</h2>
  <div class="ios-group">
    {#each connections as conn (conn.name)}
      <div class="ios-cell">
        <span class="ios-cell-text">
          <span class="ios-cell-label">{conn.name}</span>
          {#if subFor(conn)}<span class="ios-cell-sub">{subFor(conn)}</span>{/if}
        </span>
        <span class="ios-cell-value" class:is-green={conn.connected} class:is-red={!conn.connected}>
          {conn.mode}
        </span>
      </div>
    {/each}
  </div>
  <p class="ios-group-footer">
    {upCount} liaison{upCount > 1 ? 's' : ''} active{upCount > 1 ? 's' : ''} sur {connections.length}.
    Une source muette n'invente jamais de valeur : elle disparaît des écrans plutôt que d'afficher
    un chiffre périmé.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Piles</h2>
  <div class="ios-group">
    {#if batteryItems.length === 0}
      <div class="ios-cell">
        <span class="ios-cell-label">Aucun appareil à pile détecté</span>
      </div>
    {:else}
      {#each batteryItems as item (item.name)}
        <div class="ios-cell">
          <span class="ios-cell-text">
            <span class="ios-cell-label">{item.name}</span>
            {#if item.coverage !== null}
              <span class="ios-cell-sub">couverture {item.coverage} %</span>
            {/if}
          </span>
          <span class="ios-cell-value {battClass(item.pct)}">{item.pct} %</span>
        </div>
      {/each}
    {/if}
  </div>
  <p class="ios-group-footer">
    Les appareils Apple (iPhone, AirTag…) gardent leur batterie sur leur propre carte, page Pièces.
  </p>
</section>
