<script lang="ts">
  import type { CumulusMode } from '$theme/tokens';
  import { cumulus } from '$stores/cumulus.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import type {
    DaikinOperationMode,
    DaikinUnit,
    FanSpeed,
    SwingMode
  } from '$stores/daikin.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { daysUntil } from '$utils/mock-curves';
  import { haptic } from '$utils/haptic';
  import { onMount, onDestroy } from 'svelte';
  import Sparkline from '$components/ui/Sparkline.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';

  onMount(() => zigbee.connect());
  onDestroy(() => zigbee.disconnect());

  // Thermomètres Zigbee (SNZB-02 etc.) — détectés par 'thermo' dans le nom.
  const thermoSensors = $derived(
    zigbee.devices.filter(
      (d) => d.category === 'sensor' && d.friendlyName.toLowerCase().includes('thermo')
    )
  );

  // ─── Cumulus ───────────────────────────────────────────────────────
  const modes: { id: CumulusMode; label: string; domain: string }[] = [
    { id: 'OFF', label: 'Off', domain: 'grid' },
    { id: 'PV', label: 'Surplus PV', domain: 'solar' },
    { id: 'HC', label: 'HC', domain: 'hc' },
    { id: 'FORCE', label: 'Forçage', domain: 'alert' }
  ];

  // Jauge arc 270° — de 135° à 405° (en bas à gauche → en bas à droite)
  // Rayon 80, centre 90,90 dans un viewBox 180×180
  const ARC_RADIUS = 80;
  const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;
  // 270° d'arc = 75% de la circonférence
  const ARC_LENGTH = ARC_CIRCUMFERENCE * 0.75;

  const tempHistory = [55, 56, 57, 58, 60, 62, 63, 64, 64, 65, 65, 64];

  const cumulusProgress = $derived(
    Math.min(1, cumulus.temperatureC / cumulus.targetTempC)
  );
  const legionnellaDays = $derived(daysUntil(cumulus.nextLegionnellaCycle));

  // ─── Daikin ────────────────────────────────────────────────────────
  const operationModes: { id: DaikinOperationMode; label: string; color: string }[] = [
    { id: 'heating', label: 'Chaud', color: 'var(--color-hp)' },
    { id: 'cooling', label: 'Froid', color: 'var(--color-consumption)' },
    { id: 'off', label: 'Off', color: 'var(--color-muted-fg)' }
  ];
  const fanSpeeds: { id: FanSpeed; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'quiet', label: 'Quiet' },
    { id: 'level1', label: '1' },
    { id: 'level2', label: '2' },
    { id: 'level3', label: '3' },
    { id: 'level4', label: '4' },
    { id: 'level5', label: '5' }
  ];

  function currentTarget(u: DaikinUnit): number | null {
    if (u.operationMode === 'heating') return u.targetHeating;
    if (u.operationMode === 'cooling') return u.targetCooling;
    return null;
  }
  function setTarget(u: DaikinUnit, v: number) {
    haptic('light');
    if (u.operationMode === 'heating') daikin.setTargetHeating(u.id, v);
    else if (u.operationMode === 'cooling') daikin.setTargetCooling(u.id, v);
  }
  function tapOperationMode(unitId: string, mode: DaikinOperationMode) {
    haptic('medium');
    daikin.setOperationMode(unitId, mode);
  }
  function tapOnOff(u: DaikinUnit) {
    haptic('medium');
    daikin.setOnOff(u.id, !u.onOff);
  }
  function tapFanSpeed(unitId: string, sp: FanSpeed) {
    haptic('light');
    daikin.setFanSpeed(unitId, sp);
  }
  function tapSwingH(unitId: string, sw: SwingMode) {
    haptic('light');
    daikin.setSwingHorizontal(unitId, sw);
  }
  function tapSwingV(unitId: string, sw: SwingMode) {
    haptic('light');
    daikin.setSwingVertical(unitId, sw);
  }

  function tapCumulusMode(mode: typeof cumulus.currentMode) {
    haptic('medium');
    cumulus.setMode(mode);
  }

  // ─── Référence Thermo Salon (Zigbee) pour temp + humidité intérieures ─
  const thermoSalon = $derived(
    zigbee.devices.find((d) => d.friendlyName.toLowerCase() === 'thermo salon') ?? null
  );
  function thermoForZone(zone: string) {
    if (zone === 'Séjour') return thermoSalon;
    if (zone === 'Salle de bain') {
      return (
        zigbee.devices.find((d) => d.friendlyName.toLowerCase() === 'thermo sdb') ?? null
      );
    }
    return null;
  }

  // ─── Confort ───────────────────────────────────────────────────────
  // Indice simple : 100 si temp ∈ [20, 24] et humidité ∈ [40, 60]
  const comfortIndex = $derived.by(() => {
    const tempScore = Math.max(0, 100 - Math.abs(weather.tempC - 22) * 10);
    const humScore = Math.max(0, 100 - Math.abs(weather.humidity - 50) * 1.5);
    return Math.round((tempScore + humScore) / 2);
  });

  const conditionLabel: Record<string, string> = {
    clear: 'Dégagé',
    'partly-cloudy': 'Partiellement nuageux',
    cloudy: 'Couvert',
    rain: 'Pluie',
    thunderstorm: 'Orage'
  };

  const conditionIcon: Record<string, string> = {
    clear: '☀',
    'partly-cloudy': '⛅',
    cloudy: '☁',
    rain: '☂',
    thunderstorm: '⛈'
  };

  function fmtDayShort(date: Date): string {
    return date.toLocaleDateString('fr-FR', { weekday: 'short' });
  }
</script>

<svelte:head>
  <title>Climat — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Climat</h1>
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      Sanguinet
    </span>
  </header>

  <!-- ═══ Section 1 : Cumulus hero ═══ -->
  <section
    class="grid grid-cols-1 gap-4 rounded-[var(--radius-2xl)] border p-5 sm:grid-cols-[1fr_auto] sm:items-center"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex flex-col gap-3">
      <div class="flex items-baseline justify-between">
        <div>
          <span
            class="text-[11px] font-semibold tracking-[0.08em] uppercase"
            style="color: var(--color-muted-fg);"
          >
            Cumulus ECS
          </span>
          <div class="mt-1 flex items-baseline gap-1.5">
            <span
              class="text-[44px] font-bold leading-none tracking-tight"
              style="color: var(--color-fg); letter-spacing: -0.02em;"
            >
              {cumulus.temperatureC.toFixed(0)}
            </span>
            <span class="text-[20px] font-medium" style="color: var(--color-muted-fg);">
              °C
            </span>
          </div>
          <div class="mt-1 text-[12px]" style="color: var(--color-muted-fg);">
            {cumulus.trendCh >= 0 ? '↑' : '↓'}
            {Math.abs(cumulus.trendCh).toFixed(1)} °C/h · cible {cumulus.targetTempC}°C
          </div>
        </div>
      </div>

      <!-- Sélecteur mode -->
      <div class="flex gap-2">
        {#each modes as m (m.id)}
          {@const active = cumulus.currentMode === m.id}
          <button
            type="button"
            onclick={() => tapCumulusMode(m.id)}
            class="flex-1 rounded-full border py-2 text-[11px] font-semibold tracking-[0.04em] transition-colors"
            style="
              border-color: {active ? `var(--color-${m.domain})` : 'var(--color-border)'};
              background: {active ? `var(--color-${m.domain}-muted)` : 'transparent'};
              color: {active ? `var(--color-${m.domain})` : 'var(--color-muted-fg)'};
            "
            aria-pressed={active}
          >
            {m.label}
          </button>
        {/each}
      </div>

      <!-- Barre progression énergie -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between text-[11px]">
          <span style="color: var(--color-muted-fg);">Énergie injectée aujourd'hui</span>
          <span class="font-semibold" style="color: var(--color-fg);">
            {cumulus.energyTodayKwh.toFixed(1)} / {cumulus.energyTargetKwh} kWh
          </span>
        </div>
        <div
          class="h-2 w-full overflow-hidden rounded-full"
          style="background: var(--color-muted);"
        >
          <div
            class="h-full rounded-full transition-all duration-300"
            style="
              width: {Math.min(100, (cumulus.energyTodayKwh / cumulus.energyTargetKwh) * 100)}%;
              background: var(--color-solar);
            "
          ></div>
        </div>
      </div>

      <!-- Anti-légionellose -->
      <div
        class="flex items-center justify-between rounded-[var(--radius-md)] border-l-2 px-3 py-1.5 text-[12px]"
        style="
          background: var(--color-alert-muted);
          border-color: var(--color-alert);
          color: var(--color-alert);
        "
      >
        <span class="font-medium">Cycle anti-légionellose</span>
        <span class="font-semibold tabular-nums">
          dans {legionnellaDays} jour{legionnellaDays > 1 ? 's' : ''}
        </span>
      </div>

      <!-- Sparkline 24h -->
      <div class="flex flex-col gap-1">
        <span
          class="text-[10px] font-semibold tracking-[0.04em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Température 24h
        </span>
        <Sparkline data={tempHistory} color="var(--color-hc)" height={28} />
      </div>
    </div>

    <!-- Jauge arc 270° -->
    <div class="flex flex-col items-center justify-center">
      <svg viewBox="0 0 180 180" class="h-44 w-44 sm:h-52 sm:w-52" aria-hidden="true">
        <defs>
          <linearGradient id="cum-grad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="var(--color-battery)" />
            <stop offset="60%" stop-color="var(--color-solar)" />
            <stop offset="100%" stop-color="var(--color-hc)" />
          </linearGradient>
        </defs>
        <!-- Track -->
        <circle
          cx="90"
          cy="90"
          r={ARC_RADIUS}
          fill="none"
          stroke="var(--color-border)"
          stroke-width="10"
          stroke-dasharray="{ARC_LENGTH} {ARC_CIRCUMFERENCE}"
          stroke-dashoffset={ARC_CIRCUMFERENCE * 0.125}
          stroke-linecap="round"
          transform="rotate(90 90 90)"
        />
        <!-- Fill -->
        <circle
          cx="90"
          cy="90"
          r={ARC_RADIUS}
          fill="none"
          stroke="url(#cum-grad)"
          stroke-width="10"
          stroke-dasharray="{ARC_LENGTH * cumulusProgress} {ARC_CIRCUMFERENCE}"
          stroke-dashoffset={ARC_CIRCUMFERENCE * 0.125}
          stroke-linecap="round"
          transform="rotate(90 90 90)"
          style="transition: stroke-dasharray 600ms var(--ease-out);"
        />
        <text
          x="90"
          y="82"
          text-anchor="middle"
          font-size="28"
          font-weight="700"
          fill="var(--color-fg)"
          style="font-variant-numeric: tabular-nums; letter-spacing: -0.01em;"
        >
          {Math.round(cumulusProgress * 100)}%
        </text>
        <text
          x="90"
          y="102"
          text-anchor="middle"
          font-size="11"
          font-weight="500"
          fill="var(--color-muted-fg)"
        >
          chauffe
        </text>
      </svg>
      <!-- Stats secondaires -->
      <div class="mt-2 flex gap-4 text-[11px]" style="color: var(--color-muted-fg);">
        <span>{(cumulus.costPerHour * 100).toFixed(0)} cts/h</span>
        <span class="opacity-50">·</span>
        <span>1850 W</span>
      </div>
    </div>
  </section>

  <!-- ═══ Section 2 : Daikin (Salon + SdB) ═══ -->
  <section>
    <h2
      class="mb-3 text-[14px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Climatisation / Chauffage Daikin
    </h2>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {#each daikin.units as unit (unit.id)}
        {@const thermo = thermoForZone(unit.zone)}
        {@const indoorT = typeof thermo?.state.temperature === 'number' ? (thermo.state.temperature as number) : null}
        {@const indoorH = typeof thermo?.state.humidity === 'number' ? (thermo.state.humidity as number) : null}
        {@const tgt = currentTarget(unit)}
        {@const modeColor = operationModes.find((m) => m.id === unit.operationMode)?.color ?? 'var(--color-muted-fg)'}
        <article
          class="daikin-card flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
          class:daikin-on={unit.onOff && unit.operationMode !== 'off'}
          style="background: var(--color-card); border-color: var(--color-border); --neon: {modeColor};"
        >
          <!-- Header : zone + dot online + on/off -->
          <header class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  style:background-color={unit.online ? 'var(--color-battery)' : 'var(--color-alert)'}
                  title={unit.online ? 'En ligne' : 'Hors ligne'}
                  aria-hidden="true"
                ></span>
                <span class="text-[14px] font-semibold leading-tight" style="color: var(--color-fg);">
                  {unit.zone}
                </span>
              </div>
              <span class="text-[10px]" style="color: var(--color-muted-fg);">
                {unit.name}
              </span>
            </div>
            <button
              type="button"
              class="toggle-track shrink-0"
              class:toggle-on={unit.onOff}
              role="switch"
              aria-checked={unit.onOff}
              aria-label="Allumer / éteindre {unit.zone}"
              onclick={() => tapOnOff(unit)}
              disabled={!unit.online}
            >
              <span class="toggle-knob"></span>
            </button>
          </header>

          <!-- Températures : intérieur (depuis thermo) + extérieur (Daikin) -->
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                {thermo ? thermo.friendlyName : 'Intérieur'}
              </span>
              {#if indoorT !== null}
                <div class="flex items-baseline gap-2">
                  <span class="text-[22px] font-semibold tabular-nums" style="color: var(--color-fg); letter-spacing: -0.01em;">
                    {indoorT.toFixed(1)}
                  </span>
                  <span class="text-[12px]" style="color: var(--color-muted-fg);">°C</span>
                  {#if indoorH !== null}
                    <span class="text-[12px] tabular-nums" style="color: var(--color-consumption);">
                      · {Math.round(indoorH)}%
                    </span>
                  {/if}
                </div>
              {:else}
                <span class="text-[11px]" style="color: var(--color-muted-fg);">capteur indisponible</span>
              {/if}
            </div>
            <div class="flex flex-col gap-1">
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Extérieur
              </span>
              <div class="flex items-baseline gap-1">
                <span class="text-[22px] font-semibold tabular-nums" style="color: var(--color-fg); letter-spacing: -0.01em;">
                  {unit.outdoorTempC.toFixed(1)}
                </span>
                <span class="text-[12px]" style="color: var(--color-muted-fg);">°C</span>
              </div>
            </div>
          </div>

          <!-- Mode opérationnel : Chaud / Froid / Off -->
          <div class="flex flex-col gap-2">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Mode
            </span>
            <div class="flex gap-2">
              {#each operationModes as m (m.id)}
                {@const active = unit.operationMode === m.id}
                <button
                  type="button"
                  onclick={() => tapOperationMode(unit.id, m.id)}
                  disabled={!unit.onOff || !unit.online}
                  class="seg-btn flex-1"
                  class:seg-active={active}
                  style="
                    --seg-color: {m.color};
                  "
                  aria-pressed={active}
                >
                  {m.label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Consigne (selon mode actif) -->
          {#if tgt !== null && unit.onOff}
            <div class="flex items-center justify-between">
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Consigne {unit.operationMode === 'heating' ? 'chaud' : 'froid'}
              </span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onclick={() => setTarget(unit, tgt - 0.5)}
                  class="target-btn"
                  aria-label="Diminuer la consigne"
                >−</button>
                <span
                  class="text-[24px] font-bold tabular-nums"
                  style="color: {modeColor}; letter-spacing: -0.02em;"
                >
                  {tgt.toFixed(1)} <span class="text-[12px] font-medium" style="color: var(--color-muted-fg);">°C</span>
                </span>
                <button
                  type="button"
                  onclick={() => setTarget(unit, tgt + 0.5)}
                  class="target-btn"
                  aria-label="Augmenter la consigne"
                >+</button>
              </div>
            </div>
          {/if}

          <!-- Ventilation : Auto / Quiet / 1..5 -->
          <div class="flex flex-col gap-2">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Ventilation
            </span>
            <div class="flex gap-1.5 overflow-x-auto">
              {#each fanSpeeds as sp (sp.id)}
                {@const active = unit.fanSpeed === sp.id}
                <button
                  type="button"
                  onclick={() => tapFanSpeed(unit.id, sp.id)}
                  disabled={!unit.onOff || !unit.online || unit.operationMode === 'off'}
                  class="seg-btn"
                  class:seg-active={active}
                  style="--seg-color: var(--color-primary); min-width: 36px;"
                  aria-pressed={active}
                >
                  {sp.label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Orientation : H + V -->
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Horizontale
              </span>
              <div class="flex gap-1.5">
                {#each [{ id: 'off', label: 'Fixe' }, { id: 'swing', label: 'Swing' }] as sw (sw.id)}
                  {@const active = unit.swingHorizontal === sw.id}
                  <button
                    type="button"
                    onclick={() => tapSwingH(unit.id, sw.id as SwingMode)}
                    disabled={!unit.onOff || !unit.online || unit.operationMode === 'off'}
                    class="seg-btn flex-1"
                    class:seg-active={active}
                    style="--seg-color: var(--color-primary);"
                    aria-pressed={active}
                  >
                    {sw.label}
                  </button>
                {/each}
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Verticale
              </span>
              <div class="flex gap-1.5">
                {#each [{ id: 'off', label: 'Fixe' }, { id: 'swing', label: 'Swing' }] as sw (sw.id)}
                  {@const active = unit.swingVertical === sw.id}
                  <button
                    type="button"
                    onclick={() => tapSwingV(unit.id, sw.id as SwingMode)}
                    disabled={!unit.onOff || !unit.online || unit.operationMode === 'off'}
                    class="seg-btn flex-1"
                    class:seg-active={active}
                    style="--seg-color: var(--color-primary);"
                    aria-pressed={active}
                  >
                    {sw.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
  </section>

  <!-- ═══ Thermomètres Zigbee (déplacés depuis /pieces) ═══ -->
  {#if thermoSensors.length > 0}
    <section class="flex flex-col gap-3">
      <h2
        class="text-[14px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Thermomètres · {thermoSensors.length}
      </h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each thermoSensors as device (device.ieee)}
          <ZigbeeSensorTile {device} />
        {/each}
      </div>
    </section>
  {/if}

  <!-- ═══ Section 3 : Météo ═══ -->
  <section
    class="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-[var(--radius-2xl)] border p-4"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Extérieur
      </span>
      <div class="flex items-baseline gap-0.5">
        <span class="text-[28px] font-semibold" style="color: var(--color-fg); letter-spacing: -0.01em;">
          {weather.tempC.toFixed(0)}
        </span>
        <span class="text-[14px]" style="color: var(--color-muted-fg);">°C</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        {conditionIcon[weather.condition]} {conditionLabel[weather.condition]}
      </span>
    </div>

    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Humidité
      </span>
      <div class="flex items-baseline gap-0.5">
        <span class="text-[28px] font-semibold" style="color: var(--color-fg); letter-spacing: -0.01em;">
          {weather.humidity}
        </span>
        <span class="text-[14px]" style="color: var(--color-muted-fg);">%</span>
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Vent
      </span>
      <div class="flex items-baseline gap-0.5">
        <span class="text-[28px] font-semibold" style="color: var(--color-fg); letter-spacing: -0.01em;">
          {weather.windSpeedKmh}
        </span>
        <span class="text-[14px]" style="color: var(--color-muted-fg);">km/h</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Ouest
      </span>
    </div>

    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        UV
      </span>
      <div class="flex items-baseline gap-0.5">
        <span class="text-[28px] font-semibold" style="color: var(--color-solar); letter-spacing: -0.01em;">
          {weather.uvIndex}
        </span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        {weather.uvIndex > 5 ? 'Élevé' : weather.uvIndex > 2 ? 'Modéré' : 'Faible'}
      </span>
    </div>
  </section>

  <!-- ═══ Section 4 : Confort + prévisions 3j ═══ -->
  <section class="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2fr]">
    <!-- Indice de confort -->
    <article
      class="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-2xl)] border p-5"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Confort thermique
      </span>
      <div class="text-[44px] font-bold leading-none" style="color: var(--color-battery); letter-spacing: -0.02em;">
        {comfortIndex}
      </div>
      <span class="text-[12px]" style="color: var(--color-muted-fg);">
        sur 100
      </span>
    </article>

    <!-- Prévisions 3j -->
    <article
      class="rounded-[var(--radius-2xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Prévisions 3 jours
      </span>
      <div class="mt-3 grid grid-cols-3 gap-2">
        {#each weather.forecast3d as day (day.date.toISOString())}
          <div class="flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] py-2" style="background: var(--color-muted);">
            <span class="text-[11px] font-medium" style="color: var(--color-muted-fg);">
              {fmtDayShort(day.date)}
            </span>
            <span class="text-[24px]">{conditionIcon[day.condition]}</span>
            <div class="flex items-baseline gap-1 text-[12px] tabular-nums">
              <span class="font-semibold" style="color: var(--color-fg);">
                {day.tempMax}°
              </span>
              <span style="color: var(--color-muted-fg);">
                {day.tempMin}°
              </span>
            </div>
            {#if day.pop > 20}
              <span class="text-[10px]" style="color: var(--color-consumption);">
                ☂ {day.pop}%
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </article>
  </section>
</div>

<style>
  /* ─── Daikin card : glow néon quand allumée (idem switches ON) ─── */
  .daikin-card {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .daikin-on {
    border-color: var(--neon);
    box-shadow:
      0 0 12px oklch(0.546 0.215 262 / 0.40),
      0 0 26px oklch(0.546 0.215 262 / 0.18);
  }

  /* ─── Boutons segmentés (mode / fan / swing) ─── */
  .seg-btn {
    padding: 0.45rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
    white-space: nowrap;
  }
  .seg-btn:hover:not(:disabled) {
    border-color: var(--color-border-strong);
    color: var(--color-fg);
  }
  .seg-btn:active:not(:disabled) {
    transform: scale(0.97);
  }
  .seg-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .seg-active {
    border-color: var(--seg-color, var(--color-primary));
    background: color-mix(in oklch, var(--seg-color, var(--color-primary)) 14%, transparent);
    color: var(--seg-color, var(--color-primary));
  }

  /* ─── Boutons +/- de la consigne ─── */
  .target-btn {
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    background: var(--color-card);
    color: var(--color-muted-fg);
    font-size: 18px;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .target-btn:hover {
    border-color: var(--color-border-strong);
    color: var(--color-fg);
  }
  .target-btn:active {
    transform: scale(0.94);
  }

  /* ─── Toggle (cohérent SwitchTile) ─── */
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
</style>
