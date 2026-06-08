<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import { anker } from '$stores/anker.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { settings } from '$stores/settings.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { haptic } from '$utils/haptic';

  const APP_VERSION = '0.2.0';

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
    forecast.connect();
    cumulus.connectRelay(); // relais Shelly cumulus → ligne « Connexions »
    thermostat.connect(); // daemon thermostat sèche-serviette → « Connexions »
  });
  onDestroy(() => {
    daikin.disconnect();
    weather.disconnect();
    zigbee.disconnect();
    forecast.disconnect();
    cumulus.disconnectRelay();
    thermostat.disconnect();
  });

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
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Seuil surplus ON
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-primary);">
          {cumulus.surplusOnThreshold} W
        </span>
      </div>
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Seuil surplus OFF
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-primary);">
          {cumulus.surplusOffThreshold} W
        </span>
      </div>
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Durée ON min.
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-primary);">
          {Math.round(cumulus.minOnDurationSec / 60)} min
        </span>
      </div>
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Anti-cycling
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-primary);">
          {Math.round(cumulus.antiCyclingSec / 60)} min
        </span>
      </div>
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Cible
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-primary);">
          {cumulus.targetTempC}°C
        </span>
      </div>
      <div
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Max sécurité
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-alert);">
          {cumulus.maxTempC}°C
        </span>
      </div>
      <div
        class="col-span-2 flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3 sm:col-span-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Plage HC
        </span>
        <span class="text-[20px] font-bold tabular-nums" style="color: var(--color-hc);">
          {cumulus.hcStartHour}h – {cumulus.hcEndHour}h
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          Anti-légionellose ANSES ≥60°C tous les 7 jours · jamais désactivable
        </span>
      </div>
    </div>
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
      <label
        class="flex flex-col gap-1 rounded-[var(--radius-xl)] border p-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Coût installation (€)
        </span>
        <input
          type="number"
          step="100"
          bind:value={settings.installationCostEur}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
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
          Mise en service
        </span>
        <input
          type="date"
          bind:value={settings.installationDateISO}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[15px] font-semibold tabular-nums focus:outline-none"
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
          Facteur CO₂ (kg/kWh)
        </span>
        <input
          type="number"
          step="0.001"
          bind:value={settings.co2FactorKgKwh}
          onchange={() => {
            haptic('success');
            settings.save();
          }}
          class="bg-transparent text-[18px] font-bold tabular-nums focus:outline-none"
          style="color: var(--color-fg);"
        />
      </label>
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
    box-shadow: 0 1px 2px oklch(0 0 0 / 0.15);
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
