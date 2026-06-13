<script lang="ts">
  /**
   * Carte « Salle de bain » — thermostat du sèche-serviette (EN SERVICE).
   *
   * Harmonisée avec le Daikin : header (point + titre + switch on/off), cadran
   * héros (température mesurée au centre, consigne en repère), pills de réglage
   * (Éco / Confort / Boost 1 h), bandeau infos (humidité + extérieur), et en bas
   * l'indicateur de chauffe effective (résistance grise/rouge) + le forçage.
   * Pilote le daemon thermostat-bridge via le store `thermostat`.
   */
  import { thermostat, type ThermostatPreset } from '$stores/thermostat.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';
  import TempGauge from '$components/ui/TempGauge.svelte';

  // Échelle du cadran thermomètre (température ambiante d'une SdB).
  const SCALE_MIN = 10;
  const SCALE_MAX = 26;

  const PRESET_LABEL: Record<ThermostatPreset, string> = {
    frost: 'Hors-gel',
    eco: 'Éco',
    comfort: 'Confort',
    boost: 'Boost',
    off: 'Arrêt',
    manual: 'Manuel'
  };
  const PRESET_COLOR: Record<ThermostatPreset, string> = {
    frost: 'var(--color-consumption)',
    eco: 'var(--color-success)',
    comfort: 'var(--color-hp)',
    boost: 'var(--color-primary)',
    off: 'var(--color-muted-fg)',
    manual: 'var(--color-muted-fg)'
  };

  // Pills de réglage : Éco / Confort (presets) + Boost 1 h (action dédiée).
  const PILLS: { key: ThermostatPreset; label: string; color: string; boost?: boolean }[] = [
    { key: 'eco', label: 'Éco', color: 'var(--color-success)' },
    { key: 'comfort', label: 'Confort', color: 'var(--color-hp)' },
    { key: 'boost', label: 'Boost 1 h', color: 'var(--color-primary)', boost: true }
  ];

  // « Chauffe » = le relais est réellement alimenté (sortie TPI du daemon).
  const heating = $derived(thermostat.connected && thermostat.switchOn === true);
  const override = $derived(thermostat.override);
  const nextTransition = $derived(thermostat.nextTransition);
  const hasSafetyAlert = $derived(thermostat.windowOpen || thermostat.safety !== 'ok');
  // Marche/arrêt du thermostat (≠ relais) : « éteint » = preset Arrêt / Hors-gel.
  const isOff = $derived(thermostat.activePreset === 'off' || thermostat.activePreset === 'frost');
  const isOn = $derived(thermostat.connected && !isOff);
  const gaugeColor = $derived(
    !thermostat.connected || isOff
      ? 'var(--color-muted-fg)'
      : heating
        ? 'var(--color-hp)'
        : PRESET_COLOR[thermostat.activePreset]
  );
  const outdoor = $derived(thermostat.outdoorTempC ?? weather.tempC);

  // T°/HR réelles = capteur Zigbee « Thermo SdB » (le daemon lit le même capteur).
  const sdbSensor = $derived(
    zigbee.devices.find((d) => d.friendlyName.toLowerCase() === 'thermo sdb') ?? null
  );
  const roomTemp = $derived(
    typeof sdbSensor?.state.temperature === 'number'
      ? (sdbSensor.state.temperature as number)
      : thermostat.roomTempC
  );
  const roomHum = $derived(
    typeof sdbSensor?.state.humidity === 'number'
      ? (sdbSensor.state.humidity as number)
      : thermostat.humidity
  );

  function toggleOnOff() {
    if (!thermostat.connected) return;
    haptic('medium');
    thermostat.setPreset(isOn ? 'off' : 'eco');
  }
  function pick(preset: ThermostatPreset) {
    if (!thermostat.connected) return;
    haptic('light');
    thermostat.setPreset(preset);
  }
  function doBoost() {
    if (!thermostat.connected) return;
    haptic('medium');
    thermostat.boost(60); // Boost 1 h
  }
  function backToPlanning() {
    haptic('light');
    thermostat.clearOverride();
  }
  function fmtTime(d: Date | null): string {
    return d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  }
</script>

<section
  class="thermo-card relative flex flex-col gap-5 overflow-hidden rounded-[var(--radius-2xl)] border p-5"
  class:thermo-heating={heating}
  style="background: var(--color-card); border-color: {heating
    ? 'var(--color-hp)'
    : 'var(--color-border)'}; --halo: {gaugeColor};"
>
  <!-- Halo ambient (bas-droite, s'allume quand ça chauffe) -->
  <div class="ambient-halo" aria-hidden="true"></div>

  <!-- Header : point + titre + switch on/off (comme Daikin) -->
  <div class="relative z-10">
    <header class="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          style:background-color={thermostat.connected
            ? 'var(--color-battery)'
            : 'var(--color-alert)'}
          title={thermostat.connected ? 'En ligne' : 'Hors ligne'}
          aria-hidden="true"
        ></span>
        <span
          class="truncate text-[15px] leading-tight font-semibold"
          style="color: var(--color-fg);"
        >
          Salle de bain
        </span>
      </div>
      <button
        type="button"
        data-no-haptic
        class="toggle-track shrink-0"
        class:toggle-on={isOn}
        role="switch"
        aria-checked={isOn}
        aria-label="Allumer / éteindre le chauffage salle de bain"
        onclick={toggleOnOff}
        disabled={!thermostat.connected}
      >
        <span class="toggle-knob"></span>
      </button>
    </header>

    <div class="-mb-10 flex items-center justify-center">
      <TempGauge
        value={roomTemp != null ? Math.round(roomTemp * 2) / 2 : SCALE_MIN}
        currentValue={thermostat.connected ? thermostat.targetTempC : null}
        min={SCALE_MIN}
        max={SCALE_MAX}
        step={0.5}
        color={gaugeColor}
        readonly
        disabled={roomTemp == null}
        label={thermostat.connected && thermostat.targetTempC != null
          ? `cible ${thermostat.targetTempC}°`
          : ''}
        offLabel="—"
        offSubLabel="température inconnue"
        onChange={() => {}}
      />
    </div>

    <!-- Contexte planning (mode auto sans forçage) -->
    {#if thermostat.connected && !override && thermostat.mode === 'auto'}
      <div
        class="flex items-center justify-center gap-1.5 text-[12px]"
        style="color: var(--color-muted-fg);"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span>
          Auto{#if nextTransition}
            · {PRESET_LABEL[nextTransition.preset]} à {fmtTime(nextTransition.at)}{/if}
        </span>
      </div>
    {/if}
  </div>

  <!-- Réglages : Éco / Confort / Boost 1 h -->
  <div class="relative z-10 flex gap-2">
    {#each PILLS as p (p.key)}
      {@const active = thermostat.connected && thermostat.activePreset === p.key}
      <button
        type="button"
        class="mode-pill flex-1"
        class:mode-active={active}
        style="--mp-color: {p.color};"
        data-no-haptic
        disabled={!thermostat.connected}
        aria-pressed={active}
        onclick={() => (p.boost ? doBoost() : pick(p.key))}
      >
        {p.label}
      </button>
    {/each}
  </div>

  <!-- Bandeau infos : humidité + extérieur -->
  <div
    class="relative z-10 grid grid-cols-2 gap-3 rounded-[var(--radius-lg)] border p-3"
    style="border-color: var(--color-border); background: var(--color-muted);"
  >
    <div class="flex items-center gap-2">
      <svg
        class="shrink-0"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="color: var(--color-consumption);"
        aria-hidden="true"
      >
        <path
          d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"
        />
      </svg>
      {#if roomHum != null}
        <span
          class="text-[17px] font-semibold tabular-nums"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
          {Math.round(roomHum)}%
        </span>
      {:else}
        <span class="text-[17px] font-semibold" style="color: var(--color-muted-fg);">—</span>
      {/if}
    </div>
    <div class="flex items-center justify-end gap-2">
      <svg
        class="shrink-0"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="color: var(--color-solar);"
        aria-hidden="true"
      >
        <path d="m2 13 7-5.5 7 5.5" />
        <path d="M4 11.5V20h10v-8.5" />
        <circle cx="18.5" cy="5.5" r="2" />
        <path d="M18.5 1.5v1M18.5 9.5v-1M14.5 5.5h1M22.5 5.5h-1M15.7 2.7l.7.7M21.3 8.3l-.7-.7" />
      </svg>
      <span
        class="text-[17px] font-semibold tabular-nums"
        style="color: var(--color-fg); letter-spacing: -0.01em;"
      >
        {outdoor != null ? `${outdoor.toFixed(1)}°` : '—'}
      </span>
    </div>
  </div>

  <!-- Bas : chauffe effective + forçage, dans des pilules (harmonie avec les pills) -->
  <div class="relative z-10 flex flex-wrap items-center justify-between gap-2">
    <span
      class="info-chip"
      style="border-color: {heating
        ? 'var(--color-hp)'
        : 'var(--color-border)'}; background: {heating
        ? 'var(--color-hp-muted)'
        : 'var(--color-muted)'}; color: {heating ? 'var(--color-hp)' : 'var(--color-muted-fg)'};"
      title={heating ? 'Le sèche-serviette chauffe' : 'Sèche-serviette en veille'}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <!-- Résistance chauffante : ondulations de chaleur montantes -->
        <path d="M8 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
        <path d="M12 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
        <path d="M16 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
      </svg>
      {heating ? 'Chauffe' : 'En veille'}
    </span>
    {#if thermostat.connected && override}
      <span class="info-chip" style="color: var(--color-muted-fg);">
        <span
          >Forcé{#if override.until}
            jusqu'à {fmtTime(override.until)}{/if}</span
        >
        <button type="button" class="tw-link" onclick={backToPlanning}>Revenir à l'auto</button>
      </span>
    {/if}
  </div>

  <!-- Sécurité : fenêtre ouverte / sonde perdue / sécurité haute -->
  {#if hasSafetyAlert}
    <div
      class="relative z-10 rounded-[var(--radius-md)] border-l-2 px-3 py-2 text-[12px]"
      style="background: var(--color-alert-muted); border-color: var(--color-alert); color: var(--color-alert);"
    >
      <span class="font-medium">
        {#if thermostat.windowOpen}Fenêtre ouverte — chauffe en pause
        {:else if thermostat.safety === 'sensor_lost'}Thermomètre injoignable
        {:else if thermostat.safety === 'over_max'}Sécurité haute atteinte
        {:else}Anomalie de chauffe{/if}
      </span>
    </div>
  {/if}
</section>

<style>
  .thermo-card {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }

  /* Halo ambient — couleur de l'état, en bas-droite, allumé quand ça chauffe */
  .ambient-halo {
    position: absolute;
    right: -40%;
    bottom: -40%;
    width: 120%;
    height: 120%;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      color-mix(in oklch, var(--halo) 22%, transparent) 0%,
      transparent 60%
    );
    opacity: 0;
    transition: opacity 800ms var(--ease-out);
    pointer-events: none;
    z-index: 0;
  }
  .thermo-heating .ambient-halo {
    opacity: 1;
  }

  /* Switch on/off — repris à l'identique de la carte Daikin */
  .toggle-track {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .toggle-on {
    background: var(--color-consumption);
    border-color: var(--color-consumption);
  }
  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.2);
    transform: translateY(-50%);
    transition: left var(--duration-normal) var(--ease-spring);
  }
  .toggle-on .toggle-knob {
    left: calc(100% - 21px);
  }
  .toggle-track:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Pills de réglage — mêmes que Chaud/Froid du Daikin */
  .mode-pill {
    padding: 0.6rem 0.5rem;
    border: 1.5px solid var(--color-border);
    border-radius: 9999px;
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .mode-pill:hover:not(:disabled) {
    color: var(--mp-color);
    border-color: var(--mp-color);
  }
  .mode-pill:active:not(:disabled) {
    transform: scale(0.96);
  }
  .mode-pill:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .mode-active {
    border-color: var(--mp-color);
    background: color-mix(in oklch, var(--mp-color) 16%, transparent);
    color: var(--mp-color);
  }

  /* Pilules d'info en bas (chauffe + forçage) — harmonie avec les pills */
  .info-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border-radius: 9999px;
    border: 1.5px solid var(--color-border);
    background: var(--color-muted);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  /* Lien « revenir à l'auto » */
  .tw-link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    color: var(--color-primary);
    text-decoration: underline;
    cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    .ambient-halo,
    .toggle-track,
    .toggle-knob,
    .mode-pill {
      transition: none;
    }
  }
</style>
