<script lang="ts">
  /**
   * Carte « Salle de bain » — thermostat du sèche-serviette (EN SERVICE).
   *
   * Reprend le TEMPLATE instrument des cartes Daikin (carte verre sombre, cadran
   * ClimateDial = température mesurée au centre, consigne en arc, stats humidité/
   * extérieur). Le sèche-serviette n'a PAS de consigne continue : on règle par
   * PRESETS (Éco / Confort / Boost) au lieu du +/− et de l'oscillation.
   * Pilote le daemon thermostat-bridge via le store `thermostat`.
   */
  import { thermostat, type ThermostatPreset } from '$stores/thermostat.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';
  import ClimateDial from '$components/cards/ClimateDial.svelte';

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

  // Réglages : Éco / Confort (presets) + Boost (action dédiée).
  const PILLS: { key: ThermostatPreset; label: string; color: string; boost?: boolean }[] = [
    { key: 'eco', label: 'Éco', color: 'var(--color-success)' },
    { key: 'comfort', label: 'Confort', color: 'var(--color-hp)' },
    { key: 'boost', label: 'Boost', color: 'var(--color-primary)', boost: true }
  ];

  // « Chauffe » = le relais est réellement alimenté (sortie TPI du daemon).
  const heating = $derived(thermostat.connected && thermostat.switchOn === true);
  const override = $derived(thermostat.override);
  const nextTransition = $derived(thermostat.nextTransition);
  const hasSafetyAlert = $derived(thermostat.windowOpen || thermostat.safety !== 'ok');
  // Marche/arrêt du thermostat (≠ relais) : « éteint » = preset Arrêt / Hors-gel.
  const isOff = $derived(thermostat.activePreset === 'off' || thermostat.activePreset === 'frost');
  const isOn = $derived(thermostat.connected && !isOff);
  const outdoor = $derived(thermostat.outdoorTempC ?? weather.tempC);

  // Cadran : le sèche-serviette ne fait que chauffer → mode 'heating' quand allumé.
  const dialMode = $derived(isOn ? 'heating' : 'off');
  const dialTarget = $derived(thermostat.targetTempC ?? SCALE_MIN);
  const cibleShown = $derived(
    thermostat.targetTempC != null
      ? thermostat.targetTempC % 1
        ? thermostat.targetTempC.toFixed(1)
        : thermostat.targetTempC.toFixed(0)
      : '—'
  );

  // ─── Logique d'affichage : Auto vs Manuel ; le Hors-gel (7°) n'apparaît JAMAIS ─
  const isManual = $derived(!!override); // un override = forçage manuel
  // La consigne n'a de sens qu'en Éco / Confort / Boost (16 / 22 / 24°).
  const showCible = $derived(
    !isOff &&
      (thermostat.activePreset === 'eco' ||
        thermostat.activePreset === 'comfort' ||
        thermostat.activePreset === 'boost')
  );
  const stateLabel = $derived.by(() => {
    if (!thermostat.connected) return 'Hors ligne';
    if (isOff) return 'Arrêt'; // off OU frost → « Arrêt » (jamais « 7° »)
    const p = PRESET_LABEL[thermostat.activePreset] ?? '—';
    return isManual ? p : `Auto · ${p}`;
  });

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
    // ON → retour en Auto (le planning décide Éco/Confort) ; OFF → Arrêt.
    if (isOn) thermostat.setPreset('off');
    else thermostat.clearOverride();
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
  class="tw-card relative flex flex-col gap-2 overflow-hidden rounded-[var(--radius-2xl)] p-2.5"
>
  <!-- Haut, une ligne : nom · humidité + extérieur · toggle -->
  <header class="flex items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        style:background-color={thermostat.connected ? '#4ade80' : '#f0606a'}
        title={thermostat.connected ? 'En ligne' : 'Hors ligne'}
        aria-hidden="true"
      ></span>
      <span class="tw-name truncate">Salle de bain</span>
    </div>
    <div class="flex shrink-0 items-center gap-2.5">
      <span class="tw-stat c">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5C12 2.5 6 9.5 6 14a6 6 0 0 0 12 0C18 9.5 12 2.5 12 2.5Z" />
        </svg>
        {roomHum != null ? `${Math.round(roomHum)}%` : '—'}
      </span>
      <span class="tw-stat o">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          />
        </svg>
        {outdoor != null ? `${outdoor.toFixed(1)}°` : '—'}
      </span>
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
    </div>
  </header>

  <!-- Cadran (mesure) + presets Éco / Confort / Boost à droite -->
  <div class="flex items-center justify-center gap-3">
    <ClimateDial
      value={roomTemp}
      target={dialTarget}
      min={SCALE_MIN}
      max={SCALE_MAX}
      mode={dialMode}
      on={isOn}
    />
    <div class="flex flex-col gap-1.5" role="group" aria-label="Réglage du chauffage">
      {#each PILLS as p (p.key)}
        {@const active = thermostat.connected && thermostat.activePreset === p.key}
        <button
          type="button"
          data-no-haptic
          class="seg"
          class:on={active}
          style="--seg: {p.color};"
          disabled={!thermostat.connected}
          aria-pressed={active}
          onclick={() => (p.boost ? doBoost() : pick(p.key))}
        >
          {p.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Bandeau métal : état de chauffe + cible (lecture seule, pas de +/−) -->
  <div class="tw-bar">
    <span
      class="chauffe"
      class:hot={heating}
      title={heating ? 'Le sèche-serviette chauffe' : 'En veille'}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
        <path d="M12 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
        <path d="M16 19c-1.6-2-1.6-3.5 0-5.5s1.6-3.5 0-5.5" />
      </svg>
      {heating ? 'Chauffe' : 'Veille'}
    </span>
    <div class="tw-tgt">
      {#if showCible}
        <b>{cibleShown}<i>°</i></b>
        <span>{stateLabel}</span>
      {:else}
        <span class="tw-arret">{stateLabel}</span>
      {/if}
    </div>
  </div>

  <!-- Contexte planning / forçage (compact) -->
  {#if thermostat.connected && override}
    <div class="tw-foot">
      <span
        >Forcé{#if override.until}
          → {fmtTime(override.until)}{/if}</span
      >
      <button type="button" class="tw-link" onclick={backToPlanning}>Revenir à l'auto</button>
    </div>
  {:else if thermostat.connected && !isOff && thermostat.mode === 'auto' && nextTransition}
    <div class="tw-foot">
      <span>→ {PRESET_LABEL[nextTransition.preset]} à {fmtTime(nextTransition.at)}</span>
    </div>
  {/if}

  <!-- Sécurité : fenêtre ouverte / sonde perdue / sécurité haute -->
  {#if hasSafetyAlert}
    <div class="tw-alert">
      {#if thermostat.windowOpen}Fenêtre ouverte — chauffe en pause
      {:else if thermostat.safety === 'sensor_lost'}Thermomètre injoignable
      {:else if thermostat.safety === 'over_max'}Sécurité haute atteinte
      {:else}Anomalie de chauffe{/if}
    </div>
  {/if}
</section>

<style>
  /* Carte instrument verre sombre (alignée sur les cartes Daikin) */
  .tw-card {
    color: #e8eefb;
    background: radial-gradient(130% 100% at 50% 16%, #17223a 0%, #0a1020 50%, #05080f 100%);
    border: 1px solid rgba(120, 160, 255, 0.1);
    /* Contour « plexiglass » de l'app (arête bleue HG / ombre verte BD) + relief sombre. */
    box-shadow:
      var(--shadow-md),
      0 24px 64px rgba(0, 0, 0, 0.62),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  .tw-name {
    font-size: 15px;
    font-weight: 600;
    color: #eef5ff;
  }
  .tw-stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .tw-stat.c {
    color: #7fdcff;
  }
  .tw-stat.o {
    color: #ffc46b;
  }

  /* Presets Éco / Confort / Boost — boutons empilés (verre) */
  .seg {
    min-width: 62px;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.04);
    color: #8c9bb5;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .seg:active:not(:disabled) {
    transform: scale(0.95);
  }
  .seg:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .seg.on {
    background: color-mix(in oklab, var(--seg) 22%, transparent);
    color: var(--seg);
    border-color: color-mix(in oklab, var(--seg) 55%, transparent);
  }

  /* Bandeau métal : chauffe + cible */
  .tw-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 12px;
    border-radius: 15px;
    background: linear-gradient(180deg, #4a5165 0%, #2a3142 32%, #1b2130 62%, #3b4354 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      inset 0 -3px 7px rgba(0, 0, 0, 0.45);
  }
  .chauffe {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    color: #9aa7bd;
  }
  .chauffe.hot {
    color: #ff8f6b;
  }
  .tw-tgt {
    text-align: center;
    line-height: 1;
  }
  .tw-tgt b {
    font-size: 20px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: #eef5ff;
  }
  .tw-tgt b i {
    font-size: 11px;
    font-style: normal;
    color: #ffc46b;
    vertical-align: top;
  }
  .tw-tgt span {
    display: block;
    font-size: 10px;
    letter-spacing: 0.02em;
    color: #b7c2d6;
  }
  /* État « Arrêt » (ni cible ni 7°) — centré dans le bandeau */
  .tw-arret {
    font-size: 15px;
    font-weight: 500;
    color: #9aa7bd;
    letter-spacing: 0.01em;
  }

  .tw-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: #8b9bb4;
  }
  .tw-link {
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: #7fb8ff;
    text-decoration: underline;
    cursor: pointer;
  }
  .tw-alert {
    border-radius: 9px;
    border-left: 2px solid #ff7a6b;
    background: rgba(255, 90, 80, 0.14);
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 500;
    color: #ffb3a8;
  }

  /* Toggle on/off (repris à l'identique) */
  .toggle-track {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.18);
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .toggle-on {
    background: #1772c2;
    border-color: #2a90e0;
  }
  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
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
</style>
