<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import { anker } from '$stores/anker.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { airzone } from '$stores/airzone.svelte';
  import { cumulus, type CumulusConfigClient } from '$stores/cumulus.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { settings } from '$stores/settings.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { tariff } from '$stores/tariff.svelte';
  import { haptic } from '$utils/haptic';

  const APP_VERSION = '0.2.0';

  // ─── Tarif RÉEL en cours (store tariff, connecté app-wide via le layout) ──
  const tariffReady = $derived(tariff.status === 'live'); // évite le flash 0,00 avant le 1er fetch
  const currentTariff = $derived(tariff.period);
  const currentPrice = $derived(tariff.priceEurKwh); // €/kWh
  const nextTariff = $derived(tariff.next.period);
  const nextSwitchAt = $derived(tariff.next.at); // 'HH:MM' local Paris
  const hoursUntilSwitch = $derived(tariff.nextInHours);

  onMount(() => {
    preferences.hydrate();
    settings.hydrate();
    if (matter.connectionStatus === 'disconnected') {
      matter.connect();
    }
    // Connecter les stores affichés dans « Connexions » pour des états RÉELS et
    // à jour (anker/apsystems sont déjà connectés app-wide via le layout).
    daikin.connect();
    weather.connect();
    zigbee.connect();
    airzone.connect(); // pour la section « Batteries » (thermostats de zone)
    forecast.connect();
    cumulus.connectRelay(); // relais Shelly cumulus → ligne « Connexions »
    cumulus.refreshOrchestrator(); // config + état du moteur cumulus
    thermostat.connect(); // daemon thermostat sèche-serviette → « Connexions »
  });
  onDestroy(() => {
    daikin.disconnect();
    weather.disconnect();
    zigbee.disconnect();
    airzone.disconnect();
    forecast.disconnect();
    cumulus.disconnectRelay();
    thermostat.disconnect();
  });

  // ─── Batteries regroupées (toute l'app) — hors appareils Apple (cf. FindMyCard) ──
  // Niveaux des appareils Zigbee (capteurs) + thermostats de zone Airzone, triés du
  // plus faible au plus fort (le plus urgent en tête).
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
  function batteryColor(pct: number): string {
    return pct > 50
      ? 'var(--color-battery)'
      : pct > 20
        ? 'var(--color-warning)'
        : 'var(--color-alert)';
  }

  // ─── Config cumulus éditable (orchestrateur) ───────────────────────
  // Copie locale bindable, seedée une fois la config réelle reçue du serveur ;
  // chaque modification est persistée (PUT /api/cumulus/config, normalisé serveur).
  let cumulusCfg = $state<CumulusConfigClient | null>(null);
  $effect(() => {
    if (cumulus.config && !cumulusCfg) cumulusCfg = { ...cumulus.config };
  });
  function saveCumulusCfg() {
    if (cumulusCfg) cumulus.saveConfig($state.snapshot(cumulusCfg));
  }

  // ─── Section 1 : Connexions ────────────────────────────────────────
  type ConnEntry = {
    name: string;
    connected: boolean;
    mode:
      | 'mock'
      | 'proxy'
      | 'direct'
      | 'connected'
      | 'connecting'
      | 'disconnected'
      | 'unconfigured';
    lastUpdate: Date | null;
    devices?: number;
  };

  const connections = $derived<ConnEntry[]>([
    {
      name: 'Anker Solix',
      connected: anker.connected,
      mode: anker.status === 'connected' ? 'direct' : 'mock',
      lastUpdate: anker.lastUpdate,
      devices: anker.batteries.length
    },
    {
      name: 'Matter',
      connected: matter.connectionStatus === 'connected',
      mode: matter.connectionStatus,
      lastUpdate: null,
      devices: matter.shutters.length + matter.switches.length
    },
    {
      name: 'Daikin Onecta',
      connected: daikin.connected,
      mode: daikin.mode,
      lastUpdate: daikin.lastUpdate,
      devices: daikin.units.length
    },
    {
      name: 'Prévision PV',
      connected: forecast.status === 'live',
      mode:
        forecast.status === 'live'
          ? 'direct'
          : forecast.status === 'error'
            ? 'disconnected'
            : 'connecting',
      lastUpdate: null
    },
    {
      name: 'Open-Meteo',
      connected: weather.connected,
      mode: weather.mode,
      lastUpdate: weather.lastUpdate
    },
    {
      name: 'Zigbee2MQTT',
      connected: zigbee.connectionStatus === 'connected',
      mode: zigbee.connectionStatus,
      lastUpdate: null,
      devices: zigbee.devices.length
    },
    {
      name: 'Shelly Pro 1 · cumulus',
      connected: cumulus.relayConnected,
      mode: cumulus.relayConnected ? 'direct' : 'disconnected',
      lastUpdate: cumulus.relayConnected ? cumulus.lastUpdate : null
    },
    {
      name: 'Thermostat · sèche-serviette',
      connected: thermostat.connected,
      mode: thermostat.connected ? 'direct' : 'disconnected',
      lastUpdate: thermostat.connected ? thermostat.lastUpdate : null
    }
  ]);

  function fmtLastUpdate(d: Date | null): string {
    if (!d) return '—';
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return `il y a ${sec} s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `il y a ${min} min`;
    return `il y a ${Math.round(min / 60)} h`;
  }

  // Sauvegarde (settings.json) + propagation au daemon de la config thermostat.
  function saveThermostat() {
    haptic('success');
    settings.save();
    thermostat.pushConfig(settings.thermostat);
  }

  // ─── Section 4 : Tarifs (sync serveur via store settings) ────────
</script>

<svelte:head>
  <title>Réglages — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <h1 class="text-2xl font-semibold tracking-tight">Réglages</h1>

  <!-- ═══ Section 1 : Connexions ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Connexions
    </h2>
    <div
      class="overflow-hidden rounded-[var(--radius-xl)] border"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      {#each connections as conn, i (conn.name)}
        <div
          class="flex items-center gap-3 px-4 py-3"
          style="border-top: {i === 0 ? '0' : '1px solid var(--color-border)'};"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style:background={conn.connected ? 'var(--color-battery)' : 'var(--color-muted-fg)'}
          ></span>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-[13px] font-semibold" style="color: var(--color-fg);">
              {conn.name}
            </span>
            <span class="text-[11px]" style="color: var(--color-muted-fg);">
              {conn.mode}{conn.devices !== undefined ? ` · ${conn.devices} devices` : ''}
            </span>
          </div>
          <span class="shrink-0 text-[11px] tabular-nums" style="color: var(--color-muted-fg);">
            {fmtLastUpdate(conn.lastUpdate)}
          </span>
        </div>
      {/each}
    </div>
  </section>

  <!-- ═══ Section : Batteries (regroupées depuis toute l'app) ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Batteries
    </h2>
    {#if batteryItems.length === 0}
      <div
        class="rounded-[var(--radius-xl)] border px-4 py-3 text-[12px]"
        style="background: var(--color-card); border-color: var(--color-border); color: var(--color-muted-fg);"
      >
        Aucun appareil à batterie détecté.
      </div>
    {:else}
      <div
        class="overflow-hidden rounded-[var(--radius-xl)] border"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        {#each batteryItems as item, i (item.name)}
          <div
            class="flex items-center gap-3 px-4 py-3"
            style="border-top: {i === 0 ? '0' : '1px solid var(--color-border)'};"
          >
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              style:background-color={batteryColor(item.pct)}
            ></span>
            <span
              class="min-w-0 flex-1 truncate text-[13px] font-semibold"
              style="color: var(--color-fg);"
            >
              {item.name}
            </span>
            <div class="flex shrink-0 items-center gap-2.5">
              {#if item.coverage !== null}
                <span class="text-[11px] tabular-nums" style="color: var(--color-muted-fg);">
                  couv. {item.coverage}%
                </span>
              {/if}
              <span
                class="text-[13px] font-semibold tabular-nums"
                style="color: {batteryColor(item.pct)};"
              >
                {item.pct}%
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <span class="text-[11px]" style="color: var(--color-muted-fg);">
      Les appareils Apple gardent leur batterie sur leur propre carte (Pièces).
    </span>
  </section>

  <!-- ═══ Section 2 : Préférences ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Préférences
    </h2>
    <div
      class="flex flex-col divide-y rounded-[var(--radius-xl)] border"
      style="background: var(--color-card); border-color: var(--color-border); --tw-divide-opacity: 1;"
    >
      <!-- Theme toggle -->
      <div
        class="flex items-center justify-between gap-3 px-4 py-3"
        style="border-bottom: 1px solid var(--color-border);"
      >
        <div class="flex flex-col gap-0.5">
          <span class="text-[13px] font-semibold">Apparence</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            Light = clair, Dark = sombre
          </span>
        </div>
        <div class="flex gap-1.5">
          {#each ['light', 'dark'] as t (t)}
            {@const active = preferences.theme === t && !preferences.autoTheme}
            <button
              type="button"
              onclick={() => {
                haptic('light');
                preferences.setTheme(t as 'light' | 'dark');
              }}
              class="rounded-full border px-3 py-1 text-[12px] font-medium capitalize transition-colors"
              style="
                border-color: {active ? 'var(--color-primary)' : 'var(--color-border)'};
                background: {active ? 'var(--color-primary-muted)' : 'transparent'};
                color: {active ? 'var(--color-primary)' : 'var(--color-muted-fg)'};
              "
            >
              {t}
            </button>
          {/each}
        </div>
      </div>

      <!-- Auto theme -->
      <div
        class="flex items-center justify-between gap-3 px-4 py-3"
        style="border-bottom: 1px solid var(--color-border);"
      >
        <div class="flex flex-col gap-0.5">
          <span class="text-[13px] font-semibold">Apparence auto</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            Light 7h–19h, Dark 19h–7h
          </span>
        </div>
        <label class="toggle-pill">
          <input
            type="checkbox"
            checked={preferences.autoTheme}
            onchange={(e) => {
              haptic('light');
              preferences.setAutoTheme((e.target as HTMLInputElement).checked);
            }}
          />
          <span class="toggle-pill-knob"></span>
        </label>
      </div>

      <!-- Power unit -->
      <div
        class="flex items-center justify-between gap-3 px-4 py-3"
        style="border-bottom: 1px solid var(--color-border);"
      >
        <div class="flex flex-col gap-0.5">
          <span class="text-[13px] font-semibold">Unité de puissance</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            Affichage par défaut
          </span>
        </div>
        <div class="flex gap-1.5">
          {#each ['W', 'kW'] as u (u)}
            {@const active = preferences.powerUnit === u}
            <button
              type="button"
              onclick={() => {
                haptic('light');
                preferences.setPowerUnit(u as 'W' | 'kW');
              }}
              class="rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
              style="
                border-color: {active ? 'var(--color-primary)' : 'var(--color-border)'};
                background: {active ? 'var(--color-primary-muted)' : 'transparent'};
                color: {active ? 'var(--color-primary)' : 'var(--color-muted-fg)'};
              "
            >
              {u}
            </button>
          {/each}
        </div>
      </div>

      <!-- Animations -->
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-[13px] font-semibold">Animations</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            Désactiver pour économiser la batterie
          </span>
        </div>
        <label class="toggle-pill">
          <input
            type="checkbox"
            checked={preferences.animationsEnabled}
            onchange={(e) => {
              haptic('light');
              preferences.setAnimationsEnabled((e.target as HTMLInputElement).checked);
            }}
          />
          <span class="toggle-pill-knob"></span>
        </label>
      </div>
    </div>
  </section>

  <!-- ═══ Section 3 : Configuration cumulus ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Cumulus
    </h2>
    {#if cumulusCfg}
      <!-- Profil de régulation -->
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Profil de régulation
        </span>
        <select
          bind:value={cumulusCfg.profile}
          onchange={saveCumulusCfg}
          class="w-full bg-transparent text-[16px] font-semibold outline-none"
          style="color: var(--color-fg);"
        >
          <option value="solar_first">Solaire d'abord (éco)</option>
          <option value="balanced">Équilibré</option>
          <option value="comfort_first">Confort d'abord</option>
        </select>
      </label>

      <!-- Températures (°C) -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Confort mini (°C)</span
          >
          <input
            type="number"
            step="1"
            bind:value={cumulusCfg.tminConfortC}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-fg);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Max sécurité (°C)</span
          >
          <input
            type="number"
            step="1"
            bind:value={cumulusCfg.tmaxSondeC}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-alert);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Calibration sonde (°C)</span
          >
          <input
            type="number"
            step="0.5"
            bind:value={cumulusCfg.tempOffsetC}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-fg);"
          />
        </label>
      </div>

      <!-- Surplus, durées, prévision -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Surplus ON (W)</span
          >
          <input
            type="number"
            step="100"
            bind:value={cumulusCfg.surplusOnW}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-primary);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Surplus OFF (W)</span
          >
          <input
            type="number"
            step="100"
            bind:value={cumulusCfg.surplusOffW}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-primary);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Peu de soleil si &lt; (kWh)</span
          >
          <input
            type="number"
            step="1"
            bind:value={cumulusCfg.forecastFaibleKwh}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-solar);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Durée ON min (s)</span
          >
          <input
            type="number"
            step="30"
            bind:value={cumulusCfg.minOnSec}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-fg);"
          />
        </label>
        <label
          class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <span
            class="text-[10px] font-semibold tracking-[0.04em] uppercase"
            style="color: var(--color-muted-fg);">Anti-cycling (s)</span
          >
          <input
            type="number"
            step="30"
            bind:value={cumulusCfg.antiCyclingSec}
            onchange={saveCumulusCfg}
            class="w-full bg-transparent text-[20px] font-bold tabular-nums outline-none"
            style="color: var(--color-fg);"
          />
        </label>
      </div>

      <p class="text-[11px] leading-relaxed" style="color: var(--color-muted-fg);">
        Le moteur décide QUAND chauffer ; c'est le CUMULUS (sa molette) qui décide la fin : il coupe
        l'alimentation quand l'eau est à sa consigne, et le moteur le détecte (conso → 0). Aucune
        cible de température. « Solaire d'abord » : ouvre le relais dès qu'il y a du surplus PV, et
        laisse le cumulus chauffer à fond (gratuit + désinfecté ≥60°C). La nuit (heures creuses
        00:06–08:06), il ne chauffe QUE si peu de soleil est prévu demain (sous {cumulusCfg.forecastFaibleKwh}
        kWh) — sinon rien. On ne relance une chauffe que lorsque l'eau a rebaissé de {cumulusCfg.rechargeHysteresisC}°C
        sous la dernière charge. Confort mini {cumulusCfg.tminConfortC}°C toujours garanti ·
        sécurité
        {cumulusCfg.tmaxSondeC}°C · watchdog auto-off {Math.round(cumulusCfg.autoOffDelaySec / 60)} min.
      </p>
    {:else}
      <p class="text-[12px]" style="color: var(--color-muted-fg);">
        Chargement de la configuration…
      </p>
    {/if}
  </section>

  <!-- ═══ Section 3 bis : Thermostat sèche-serviette ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Thermostat sèche-serviette
    </h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <!-- Presets -->
      <div
        class="col-span-2 -mb-1 text-[10px] font-semibold tracking-[0.06em] uppercase sm:col-span-4"
        style="color: var(--color-muted-fg);"
      >
        Presets (°C)
      </div>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Hors-gel
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.presetTemps.frost}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-consumption);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Éco
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.presetTemps.eco}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-success);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Confort
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.presetTemps.comfort}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-hp);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Boost
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.presetTemps.boost}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-primary);"
        />
      </label>

      <!-- Régulation TPI -->
      <div
        class="col-span-2 -mb-1 text-[10px] font-semibold tracking-[0.06em] uppercase sm:col-span-4"
        style="color: var(--color-muted-fg);"
      >
        Régulation TPI
      </div>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Coef. int
        </span>
        <input
          type="number"
          step="0.05"
          bind:value={settings.thermostat.coefInt}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Coef. ext
        </span>
        <input
          type="number"
          step="0.005"
          bind:value={settings.thermostat.coefExt}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Cycle (s)
        </span>
        <input
          type="number"
          step="30"
          bind:value={settings.thermostat.cycleSec}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Boost (min)
        </span>
        <input
          type="number"
          step="5"
          bind:value={settings.thermostat.boostDefaultMin}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Pré-chauffe (min)
        </span>
        <input
          type="number"
          step="5"
          bind:value={settings.thermostat.preheatMin}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>

      <!-- Sécurité -->
      <div
        class="col-span-2 -mb-1 text-[10px] font-semibold tracking-[0.06em] uppercase sm:col-span-4"
        style="color: var(--color-muted-fg);"
      >
        Sécurité
      </div>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Min (°C)
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.minTempC}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Max (°C)
        </span>
        <input
          type="number"
          step="0.5"
          bind:value={settings.thermostat.maxTempC}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-alert);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Chute fenêtre (°C)
        </span>
        <input
          type="number"
          step="0.1"
          bind:value={settings.thermostat.windowDropC}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Fenêtre (min)
        </span>
        <input
          type="number"
          step="1"
          bind:value={settings.thermostat.windowDropMin}
          onchange={saveThermostat}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
    </div>
    <p class="text-[11px]" style="color: var(--color-muted-fg);">
      Régulation TPI : puissance ON = coef. int × (cible − pièce) + coef. ext × (cible − extérieur),
      appliquée par cycles. Modifs propagées au daemon en direct.
    </p>
    <a
      href="/reglages/planning"
      class="flex items-center justify-between rounded-[var(--radius-xl)] border px-4 py-3"
      style="background: var(--color-card); border-color: var(--color-border); color: var(--color-fg);"
      data-sveltekit-preload-data
    >
      <span class="flex flex-col gap-0.5">
        <span class="text-[13px] font-semibold">Planning d'Isabelle</span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          Créneaux d'occupation hebdomadaires → confort salle de bain
        </span>
      </span>
      <span class="text-[18px]" style="color: var(--color-primary);">→</span>
    </a>
  </section>

  <!-- ═══ Section 4 : Tarifs ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Tarifs EDF
    </h2>

    <!-- ═══ Tarif en cours / prochaine bascule (RÉEL, lecture seule) ═══ -->
    <!-- Déplacé depuis l'accueil — état HP/HC live et heure de bascule. -->
    <div
      class="flex flex-col rounded-[var(--radius-xl)] border"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <span
          class="text-[10px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Tarif en cours
        </span>
        <span
          class="text-[14px] font-semibold tabular-nums"
          style="color: {currentTariff === 'HC' ? 'var(--color-hc)' : 'var(--color-hp)'};"
        >
          {#if tariffReady}{currentTariff} · {(currentPrice * 100).toFixed(2)} cts/kWh{:else}—{/if}
        </span>
      </div>

      <div
        class="flex items-center justify-between gap-3 border-t px-4 py-3"
        style="border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Prochaine bascule
        </span>
        <span class="text-[14px] tabular-nums" style="color: var(--color-fg);">
          {#if tariffReady && nextSwitchAt}{nextTariff} à {nextSwitchAt} · dans {hoursUntilSwitch}
            h{:else}—{/if}
        </span>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          HC (€/kWh)
        </span>
        <input
          type="number"
          step="0.0001"
          bind:value={settings.priceHc}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-hc);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          HP (€/kWh)
        </span>
        <input
          type="number"
          step="0.0001"
          bind:value={settings.priceHp}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-hp);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Revente OA
        </span>
        <input
          type="number"
          step="0.0001"
          bind:value={settings.priceExport}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-solar);"
        />
      </label>
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Abonnement
        </span>
        <input
          type="number"
          step="0.01"
          bind:value={settings.subscription}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
    </div>

    <!-- ═══ Installation — phases datées (matériel ajouté en plusieurs fois) ═══ -->
    <div class="mt-3 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Installation · {settings.installationPhases.length} phase{settings.installationPhases
            .length > 1
            ? 's'
            : ''} · {Math.round(settings.installationTotalEur)} €
        </span>
        <button
          type="button"
          onclick={() => {
            haptic('success');
            settings.addPhase();
          }}
          class="rounded-lg px-2.5 py-1 text-[12px] font-semibold"
          style="background: var(--color-muted); color: var(--color-fg);"
        >
          + Phase
        </button>
      </div>
      {#each settings.installationPhases as phase (phase.id)}
        <div
          class="flex flex-wrap items-end gap-2 rounded-[var(--radius-xl)] border p-3"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <label class="flex min-w-[7rem] flex-1 flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Matériel
            </span>
            <input
              type="text"
              bind:value={phase.label}
              onchange={() => {
                haptic('success');
                settings.save();
              }}
              placeholder="ex. SB3 Pro + panneaux"
              class="bg-transparent text-[14px] font-semibold focus:outline-none"
              style="color: var(--color-fg);"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Mise en service
            </span>
            <input
              type="date"
              bind:value={phase.dateISO}
              onchange={() => {
                haptic('success');
                settings.save();
              }}
              class="bg-transparent text-[14px] font-semibold tabular-nums focus:outline-none"
              style="color: var(--color-fg);"
            />
          </label>
          <label class="flex w-[5.5rem] flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Coût €
            </span>
            <input
              type="number"
              step="10"
              bind:value={phase.costEur}
              onchange={() => {
                haptic('success');
                settings.save();
              }}
              class="bg-transparent text-[14px] font-bold tabular-nums focus:outline-none"
              style="color: var(--color-fg);"
            />
          </label>
          <button
            type="button"
            onclick={() => {
              haptic('success');
              settings.removePhase(phase.id);
            }}
            aria-label="Supprimer la phase"
            disabled={settings.installationPhases.length <= 1}
            class="ml-auto rounded-lg px-2 py-1 text-[14px] disabled:opacity-30"
            style="color: var(--color-alert); background: var(--color-alert-muted);"
          >
            ✕
          </button>
        </div>
      {/each}
    </div>
  </section>

  <!-- ═══ Section 5 : Infos système ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Système
    </h2>
    <div
      class="grid grid-cols-2 gap-3 rounded-[var(--radius-xl)] border p-4 sm:grid-cols-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="flex flex-col gap-1">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Version
        </span>
        <span class="text-[16px] font-semibold tabular-nums" style="color: var(--color-fg);">
          {APP_VERSION}
        </span>
      </div>
      <div class="flex flex-col gap-1">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Hôte
        </span>
        <span class="text-[16px] font-semibold" style="color: var(--color-fg);"> tazieff-dev </span>
      </div>
      <div class="flex flex-col gap-1">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Domaine
        </span>
        <span class="text-[16px] font-semibold" style="color: var(--color-fg);">
          domo.feroux.fr
        </span>
      </div>
      <div class="flex flex-col gap-1">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Code éditeur
        </span>
        <a
          href="https://code.feroux.fr"
          target="_blank"
          rel="noreferrer"
          class="text-[16px] font-semibold"
          style="color: var(--color-primary);"
        >
          code-server ↗
        </a>
      </div>
    </div>
  </section>
</div>

<style>
  .toggle-pill {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .toggle-pill input {
    position: absolute;
    inset: 0;
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 1;
  }
  .toggle-pill-knob {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-default);
  }
  .toggle-pill-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px oklch(0.1 0.01 286 / 0.15);
    transition: transform var(--duration-normal) var(--ease-spring);
  }
  .toggle-pill input:checked + .toggle-pill-knob {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .toggle-pill input:checked + .toggle-pill-knob::after {
    transform: translateX(20px);
  }
  .toggle-pill input:focus-visible + .toggle-pill-knob {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
