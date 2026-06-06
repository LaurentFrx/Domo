<script lang="ts">
  import type { CumulusMode } from '$theme/tokens';
  import { cumulus } from '$stores/cumulus.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import { airzone } from '$stores/airzone.svelte';
  import type { AirzoneMode } from '$stores/airzone.svelte';
  import type { DaikinOperationMode, DaikinUnit, FanSpeed, SwingMode } from '$stores/daikin.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { daysUntil } from '$utils/mock-curves';
  import { haptic } from '$utils/haptic';
  import { onMount, onDestroy } from 'svelte';
  import Sparkline from '$components/ui/Sparkline.svelte';
  import TempGauge from '$components/ui/TempGauge.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';

  onMount(() => {
    zigbee.connect();
    daikin.connect();
    airzone.connect();
    weather.connect();
  });
  onDestroy(() => {
    zigbee.disconnect();
    daikin.disconnect();
    airzone.disconnect();
    weather.disconnect();
  });

  // ─── Airzone (gainable) : libellés + couleurs de mode ────────────────
  const AIRZONE_MODE_META: Record<AirzoneMode, { label: string; color: string; bg: string }> = {
    cooling: {
      label: 'Froid',
      color: 'var(--color-consumption)',
      bg: 'var(--color-consumption-muted)'
    },
    heating: { label: 'Chaud', color: 'var(--color-hp)', bg: 'var(--color-hp-muted)' },
    fan: { label: 'Vent.', color: 'var(--color-muted-fg)', bg: 'var(--color-muted)' },
    dry: { label: 'Sec', color: 'var(--color-solar)', bg: 'var(--color-muted)' },
    stop: { label: 'Arrêt', color: 'var(--color-muted-fg)', bg: 'var(--color-muted)' },
    auto: { label: 'Auto', color: 'var(--color-battery)', bg: 'var(--color-muted)' },
    unknown: { label: '—', color: 'var(--color-muted-fg)', bg: 'var(--color-muted)' }
  };
  function airzoneModeMeta(m: AirzoneMode) {
    return AIRZONE_MODE_META[m] ?? AIRZONE_MODE_META.unknown;
  }

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

  // Historique RÉEL glissant de la température cumulus (relevés sonde Zigbee de la
  // session) — plus de série factice. Démarre vide, se remplit au fil des lectures.
  let tempHistory = $state<number[]>([]);
  $effect(() => {
    const t = cumulus.temperatureC;
    if (t > 0) tempHistory = [...tempHistory, t].slice(-24);
  });

  // Direction du vent : degrés (météo réelle Open-Meteo) → cardinal FR.
  function windCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  const cumulusProgress = $derived(Math.min(1, cumulus.temperatureC / cumulus.targetTempC));
  const legionnellaDays = $derived(daysUntil(cumulus.nextLegionnellaCycle));

  // ─── Daikin ────────────────────────────────────────────────────────
  // Sélecteur de mode = uniquement Chaud / Froid. L'allumage/extinction passe
  // par l'interrupteur du header (onOffMode). 'off' reste un état possible de
  // l'unité (affiché au centre de la jauge) mais n'est plus un bouton — éviter
  // la redondance avec le toggle, et le faux « Off » que le bridge ignorait.
  const operationModes: {
    id: Exclude<DaikinOperationMode, 'off'>;
    label: string;
    color: string;
    bg: string;
  }[] = [
    { id: 'heating', label: 'Chaud', color: 'var(--color-hp)', bg: 'var(--color-hp-muted)' },
    {
      id: 'cooling',
      label: 'Froid',
      color: 'var(--color-consumption)',
      bg: 'var(--color-consumption-muted)'
    }
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
  // ─── Changement de mode Chaud/Froid : appui LONG anti-fausse-manip ──────
  // Un tap simple ne suffit pas (risque d'envoyer une mauvaise consigne par
  // erreur) : il faut maintenir ~600 ms. Retour haptique au début (light) puis
  // à la validation (success). Un anneau de progression remplit le bouton.
  const HOLD_MS = 600;
  let holdMode = $state<{ unitId: string; mode: DaikinOperationMode } | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function isHolding(unitId: string, mode: DaikinOperationMode): boolean {
    return holdMode?.unitId === unitId && holdMode?.mode === mode;
  }
  function cancelHold() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdMode = null;
  }
  function startHoldMode(unitId: string, mode: DaikinOperationMode, current: DaikinOperationMode) {
    if (mode === current) return; // déjà ce mode → rien à faire
    cancelHold();
    holdMode = { unitId, mode };
    haptic('light'); // « j'ai bien démarré l'appui »
    holdTimer = setTimeout(() => {
      haptic('success'); // « validé »
      daikin.setOperationMode(unitId, mode);
      holdMode = null;
      holdTimer = null;
    }, HOLD_MS);
  }

  function tapOnOff(u: DaikinUnit) {
    haptic('medium');
    daikin.setOnOff(u.id, !u.onOff);
  }
  function tapFanSpeed(unitId: string, sp: FanSpeed) {
    daikin.setFanSpeed(unitId, sp);
  }
  function tapSwingH(unitId: string, sw: SwingMode) {
    daikin.setSwingHorizontal(unitId, sw);
  }
  function tapSwingV(unitId: string, sw: SwingMode) {
    daikin.setSwingVertical(unitId, sw);
  }

  function tapCumulusMode(mode: typeof cumulus.currentMode) {
    haptic('medium');
    cumulus.setMode(mode);
  }

  // ─── Thermo Zigbee de référence pour chaque split Daikin ────────────────
  // L'ambiante + l'humidité de la carte clim viennent du thermomètre Zigbee de
  // la pièce (le capteur interne du split est faussé — il est au plafond).
  // ⚠️ Le bridge Onecta renvoie zone:"Daikin" (non fiable) → on associe chaque
  // unité à un thermo par friendly_name via son id. L'unité réelle (id "daikin")
  // est au séjour → "Thermo Salon". (ids "salon"/"sdb" = seed mock.)
  const DAIKIN_UNIT_THERMO: Record<string, string> = {
    daikin: 'Thermo Salon',
    salon: 'Thermo Salon',
    sdb: 'Thermo SdB'
  };
  function thermoByName(name: string) {
    const n = name.toLowerCase();
    return zigbee.devices.find((d) => d.friendlyName.toLowerCase() === n) ?? null;
  }
  function thermoForUnit(unit: DaikinUnit) {
    const mapped = DAIKIN_UNIT_THERMO[unit.id];
    if (mapped) return thermoByName(mapped);
    // Repli (compat seed mock) : association par zone.
    if (unit.zone === 'Séjour') return thermoByName('Thermo Salon');
    if (unit.zone === 'Salle de bain') return thermoByName('Thermo SdB');
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
    <span class="text-[12px]" style="color: var(--color-muted-fg);"> Sanguinet </span>
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
              class="text-[44px] leading-none font-bold tracking-tight"
              style="color: var(--color-fg); letter-spacing: -0.02em;"
            >
              {cumulus.temperatureC.toFixed(0)}
            </span>
            <span class="text-[20px] font-medium" style="color: var(--color-muted-fg);"> °C </span>
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
            data-no-haptic
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

  <!-- ═══ Section 2 : Daikin — dial circulaire central ═══ -->
  <section>
    <h2
      class="mb-3 text-[14px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Climatisation / Chauffage Daikin
    </h2>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {#each daikin.units as unit (unit.id)}
        {@const thermo = thermoForUnit(unit)}
        {@const indoorT =
          typeof thermo?.state.temperature === 'number'
            ? (thermo.state.temperature as number)
            : null}
        {@const indoorH =
          typeof thermo?.state.humidity === 'number' ? (thermo.state.humidity as number) : null}
        {@const tgt = currentTarget(unit)}
        {@const modeMeta = operationModes.find((m) => m.id === unit.operationMode)}
        {@const modeColor = modeMeta?.color ?? 'var(--color-muted-fg)'}
        {@const modeBg = modeMeta?.bg ?? 'var(--color-muted)'}
        {@const TGT_MIN = 16}
        {@const TGT_MAX = 30}
        {@const active = unit.onOff && unit.operationMode !== 'off'}
        {@const gaugeFrom =
          unit.operationMode === 'cooling' ? 'oklch(0.52 0.15 260)' : 'oklch(0.5 0.15 22)'}
        {@const gaugeTo =
          unit.operationMode === 'cooling' ? 'oklch(0.8 0.13 220)' : 'oklch(0.72 0.18 48)'}
        <article
          class="daikin-card relative flex flex-col gap-5 overflow-hidden rounded-[var(--radius-2xl)] border p-5"
          class:daikin-on={active}
          style="background: var(--color-card); border-color: var(--color-border); --mode-color: {modeColor}; --mode-bg: {modeBg};"
        >
          <!-- Halo gradient ambient (en bas-droite, suit la couleur du mode) -->
          <div class="ambient-halo" aria-hidden="true"></div>

          <!-- Header minimal : dot + zone + nom + toggle -->
          <header class="relative z-10 flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2.5">
              <span
                class="h-2 w-2 rounded-full"
                style:background-color={unit.online ? 'var(--color-battery)' : 'var(--color-alert)'}
                title={unit.online ? 'En ligne' : 'Hors ligne'}
                aria-hidden="true"
              ></span>
              <div class="flex min-w-0 flex-col gap-0">
                <span
                  class="text-[15px] leading-tight font-semibold"
                  style="color: var(--color-fg);"
                >
                  {unit.zone}
                </span>
                <span class="text-[10px]" style="color: var(--color-muted-fg);">
                  {unit.name}
                </span>
              </div>
            </div>
            <button
              type="button"
              data-no-haptic
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

          <!-- Gauge circulaire de consigne (signature Yeldra) -->
          <div class="relative z-10 flex items-center justify-center">
            <TempGauge
              value={tgt ?? unit.targetHeating}
              min={TGT_MIN}
              max={TGT_MAX}
              step={0.5}
              color={active ? modeColor : 'var(--color-muted-fg)'}
              colorFrom={gaugeFrom}
              colorTo={gaugeTo}
              currentValue={indoorT}
              disabled={!active}
              label={unit.operationMode === 'heating'
                ? 'Cible chaud'
                : unit.operationMode === 'cooling'
                  ? 'Cible froid'
                  : ''}
              offLabel={unit.online ? "À l'arrêt" : 'Hors ligne'}
              offSubLabel="Consigne {unit.targetHeating}° chaud · {unit.targetCooling}° froid"
              onChange={(v) => setTarget(unit, v)}
            />
          </div>

          <!-- Mode opérationnel — appui LONG pour changer (anti-fausse-manip) -->
          <div class="relative z-10 flex gap-2">
            {#each operationModes as m (m.id)}
              {@const isActive = unit.operationMode === m.id}
              {@const holding = isHolding(unit.id, m.id)}
              <button
                type="button"
                data-no-haptic
                onpointerdown={() => startHoldMode(unit.id, m.id, unit.operationMode)}
                onpointerup={cancelHold}
                onpointerleave={cancelHold}
                onpointercancel={cancelHold}
                oncontextmenu={(e) => e.preventDefault()}
                disabled={!unit.onOff || !unit.online}
                class="mode-pill flex-1"
                class:mode-active={isActive}
                class:mode-holding={holding}
                style="--mp-color: {m.color}; --mp-bg: {m.bg}; --hold-ms: {HOLD_MS}ms;"
                aria-pressed={isActive}
                title={isActive ? undefined : 'Maintenir pour activer'}
              >
                <span class="mode-pill-label">{m.label}</span>
              </button>
            {/each}
          </div>

          <!-- Métadonnées : intérieur + extérieur (compact) -->
          <div
            class="relative z-10 grid grid-cols-2 gap-3 rounded-[var(--radius-lg)] border p-3"
            style="border-color: var(--color-border); background: var(--color-muted);"
          >
            <div class="flex flex-col gap-0.5">
              <span
                class="text-[9px] font-semibold tracking-[0.06em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Intérieur
              </span>
              {#if indoorT !== null}
                <div class="flex items-baseline gap-1.5">
                  <span
                    class="text-[18px] font-semibold tabular-nums"
                    style="color: var(--color-fg); letter-spacing: -0.01em;"
                  >
                    {indoorT.toFixed(1)}°
                  </span>
                  {#if indoorH !== null}
                    <span class="text-[11px] tabular-nums" style="color: var(--color-consumption);">
                      {Math.round(indoorH)}%
                    </span>
                  {/if}
                </div>
              {:else}
                <div class="flex items-baseline gap-1.5">
                  <span
                    class="text-[18px] font-semibold tabular-nums"
                    style="color: var(--color-muted-fg); letter-spacing: -0.01em;"
                  >
                    —°
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex flex-col gap-0.5">
              <span
                class="text-[9px] font-semibold tracking-[0.06em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Extérieur
              </span>
              <span
                class="text-[18px] font-semibold tabular-nums"
                style="color: var(--color-fg); letter-spacing: -0.01em;"
              >
                {unit.outdoorTempC.toFixed(1)}°
              </span>
            </div>
          </div>

          <!-- Ventilation : segments compactes -->
          <div class="relative z-10 flex flex-col gap-1.5">
            <span
              class="text-[9px] font-semibold tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Ventilation
            </span>
            <div class="flex gap-1">
              {#each fanSpeeds as sp (sp.id)}
                {@const isActive = unit.fanSpeed === sp.id}
                <button
                  type="button"
                  onclick={() => tapFanSpeed(unit.id, sp.id)}
                  disabled={!active}
                  class="fan-seg"
                  class:fan-seg-active={isActive}
                  aria-pressed={isActive}
                >
                  {sp.label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Orientation : 2 boutons icônes -->
          <div class="relative z-10 flex items-center justify-between gap-3">
            <span
              class="text-[9px] font-semibold tracking-[0.06em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Orientation
            </span>
            <div class="flex gap-2">
              <button
                type="button"
                onclick={() =>
                  tapSwingH(unit.id, unit.swingHorizontal === 'swing' ? 'off' : 'swing')}
                disabled={!active}
                class="swing-btn"
                class:swing-active={unit.swingHorizontal === 'swing'}
                aria-pressed={unit.swingHorizontal === 'swing'}
                title="Oscillation horizontale"
              >
                <!-- Icône ↔ -->
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              </button>
              <button
                type="button"
                onclick={() => tapSwingV(unit.id, unit.swingVertical === 'swing' ? 'off' : 'swing')}
                disabled={!active}
                class="swing-btn"
                class:swing-active={unit.swingVertical === 'swing'}
                aria-pressed={unit.swingVertical === 'swing'}
                title="Oscillation verticale"
              >
                <!-- Icône ↕ -->
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="1 17 5 21 9 17" />
                  <path d="M11 3H9a4 4 0 0 0-4 4v14" />
                  <polyline points="23 7 19 3 15 7" />
                  <path d="M13 21h2a4 4 0 0 0 4-4V3" />
                </svg>
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>
  </section>

  <!-- ═══ Climatisation gainable Airzone (3 zones) ═══ -->
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h2
        class="text-[14px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Gainable Airzone · {airzone.zones.length} zones
      </h2>
      <span class="flex items-center gap-1.5 text-[11px]" style="color: var(--color-muted-fg);">
        <span
          class="h-1.5 w-1.5 rounded-full"
          style:background-color={airzone.connected ? 'var(--color-battery)' : 'var(--color-alert)'}
        ></span>
        Système
      </span>
    </div>

    <!-- Sélecteur de mode GLOBAL (système → appliqué via la zone master) -->
    <div class="flex gap-2">
      {#each airzone.availableModes as m (m)}
        {@const mm = airzoneModeMeta(m)}
        <button
          type="button"
          data-no-haptic
          class="mode-pill flex-1"
          class:mode-active={airzone.systemMode === m}
          style="--mp-color: {mm.color}; --mp-bg: {mm.bg};"
          aria-pressed={airzone.systemMode === m}
          onclick={() => {
            if (airzone.systemMode === m) return;
            haptic('medium');
            airzone.setMode(m);
          }}
        >
          <span class="mode-pill-label">{mm.label}</span>
        </button>
      {/each}
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {#each airzone.zones as zone (zone.id)}
        {@const meta = airzoneModeMeta(zone.mode)}
        <article
          class="flex flex-col gap-2.5 rounded-[var(--radius-xl)] border p-4"
          style="background: var(--color-card); border-color: {zone.on
            ? meta.color
            : 'var(--color-border)'};"
        >
          <!-- header : nom + demande + toggle on/off -->
          <div class="flex items-center justify-between gap-2">
            <span class="text-[14px] font-semibold" style="color: var(--color-fg);">
              {zone.name}
            </span>
            <div class="flex items-center gap-2">
              {#if zone.demand}
                <span
                  class="rounded-full px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.06em] uppercase"
                  style="color: {meta.color}; background: {meta.bg};"
                >
                  actif
                </span>
              {/if}
              <button
                type="button"
                data-no-haptic
                class="toggle-track shrink-0"
                class:toggle-on={zone.on}
                role="switch"
                aria-checked={zone.on}
                aria-label="Allumer / éteindre {zone.name}"
                onclick={() => {
                  haptic('medium');
                  airzone.setOn(zone.id, !zone.on);
                }}
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </div>

          <!-- température ambiante + humidité -->
          <div class="flex items-baseline gap-2">
            <div class="flex items-baseline gap-0.5">
              <span
                class="text-[32px] leading-none font-bold tabular-nums"
                style="color: var(--color-fg); letter-spacing: -0.02em;"
              >
                {zone.roomTemp !== null ? zone.roomTemp.toFixed(1) : '—'}
              </span>
              <span class="text-[14px] font-medium" style="color: var(--color-muted-fg);">°C</span>
            </div>
            {#if zone.humidity !== null}
              <span class="text-[13px] tabular-nums" style="color: var(--color-consumption);">
                {Math.round(zone.humidity)}%
              </span>
            {/if}
          </div>

          <!-- consigne réglable (− / +) -->
          <div
            class="flex items-center justify-between border-t pt-2"
            style="border-color: var(--color-border);"
          >
            <span class="text-[11px]" style="color: var(--color-muted-fg);">Consigne</span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                data-no-haptic
                class="az-step"
                aria-label="Baisser la consigne {zone.name}"
                onclick={() => {
                  haptic('light');
                  airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) - zone.tempStep);
                }}>−</button
              >
              <span
                class="text-[15px] font-semibold tabular-nums"
                style="color: var(--color-fg); min-width: 3.5ch; text-align: center;"
              >
                {zone.setpoint !== null ? zone.setpoint.toFixed(1) : '—'}°
              </span>
              <button
                type="button"
                data-no-haptic
                class="az-step"
                aria-label="Monter la consigne {zone.name}"
                onclick={() => {
                  haptic('light');
                  airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) + zone.tempStep);
                }}>+</button
              >
            </div>
          </div>

          <!-- mode courant + batterie/couverture (zones radio) -->
          <div
            class="flex items-center justify-between text-[10px]"
            style="color: var(--color-muted-fg);"
          >
            <span
              class="font-semibold"
              style="color: {zone.on ? meta.color : 'var(--color-muted-fg)'};"
            >
              {meta.label}
            </span>
            {#if zone.battery !== null}
              <span class="flex items-center gap-1">
                <span
                  class="h-1 w-1 rounded-full"
                  style:background-color={zone.battery > 30
                    ? 'var(--color-battery)'
                    : 'var(--color-alert)'}
                ></span>
                Batt. {zone.battery}%{#if zone.coverage !== null}
                  · couv. {zone.coverage}%{/if}
              </span>
            {/if}
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
    class="grid grid-cols-2 gap-3 rounded-[var(--radius-2xl)] border p-4 sm:grid-cols-4"
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
        <span
          class="text-[28px] font-semibold"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
          {weather.tempC.toFixed(0)}
        </span>
        <span class="text-[14px]" style="color: var(--color-muted-fg);">°C</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        {conditionIcon[weather.condition]}
        {conditionLabel[weather.condition]}
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
        <span
          class="text-[28px] font-semibold"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
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
        <span
          class="text-[28px] font-semibold"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
          {weather.windSpeedKmh}
        </span>
        <span class="text-[14px]" style="color: var(--color-muted-fg);">km/h</span>
      </div>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        {windCardinal(weather.windDirection)}
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
        <span
          class="text-[28px] font-semibold"
          style="color: var(--color-solar); letter-spacing: -0.01em;"
        >
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
      <div
        class="text-[44px] leading-none font-bold"
        style="color: var(--color-battery); letter-spacing: -0.02em;"
      >
        {comfortIndex}
      </div>
      <span class="text-[12px]" style="color: var(--color-muted-fg);"> sur 100 </span>
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
          <div
            class="flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] py-2"
            style="background: var(--color-muted);"
          >
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
  /* ─── Daikin card : design Tesla/Mysa-inspired ─── */
  .daikin-card {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
    min-height: 520px;
  }
  .daikin-on {
    border-color: var(--mode-color);
  }

  /* Halo gradient ambient — couleur du mode en bas-droite */
  .ambient-halo {
    position: absolute;
    right: -40%;
    bottom: -40%;
    width: 120%;
    height: 120%;
    border-radius: 50%;
    background: radial-gradient(circle, var(--mode-bg) 0%, transparent 60%);
    opacity: 0;
    transition: opacity 800ms var(--ease-out);
    pointer-events: none;
    z-index: 0;
  }
  .daikin-on .ambient-halo {
    opacity: 1;
  }

  /* Mode pills */
  .mode-pill {
    padding: 0.6rem 0.5rem;
    border: 1.5px solid var(--color-border);
    border-radius: 9999px;
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 12px;
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
    background: var(--mp-bg);
    color: var(--mp-color);
  }
  .mode-pill:active:not(:disabled) {
    transform: scale(0.96);
  }

  /* Appui long : la pastille se remplit de --mp-color via un overlay qui
     grandit sur --hold-ms ; quand plein (= validé), le mode devient actif. */
  .mode-pill {
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }
  .mode-pill::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--mp-color);
    opacity: 0.28;
    transform: scaleX(0);
    transform-origin: left center;
  }
  .mode-pill.mode-holding {
    color: var(--mp-color);
    border-color: var(--mp-color);
  }
  .mode-pill.mode-holding::after {
    transform: scaleX(1);
    transition: transform var(--hold-ms, 600ms) linear;
  }
  .mode-pill-label {
    position: relative;
  }
  @media (prefers-reduced-motion: reduce) {
    .mode-pill.mode-holding::after {
      transition-duration: 0ms;
    }
  }

  /* Fan segments : compact horizontal bar */
  .fan-seg {
    flex: 1;
    padding: 0.4rem 0.25rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-muted-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .fan-seg:hover:not(:disabled) {
    border-color: var(--color-border-strong);
    color: var(--color-fg);
  }
  .fan-seg:active:not(:disabled) {
    transform: scale(0.97);
  }
  .fan-seg:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .fan-seg-active {
    border-color: var(--mode-color);
    background: var(--mode-bg);
    color: var(--mode-color);
  }

  /* Boutons swing icons */
  .swing-btn {
    display: inline-flex;
    width: 34px;
    height: 34px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .swing-btn:hover:not(:disabled) {
    border-color: var(--color-border-strong);
    color: var(--color-fg);
  }
  .swing-btn:active:not(:disabled) {
    transform: scale(0.94);
  }
  .swing-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .swing-active {
    border-color: var(--mode-color);
    background: var(--mode-bg);
    color: var(--mode-color);
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

  /* Airzone : steppers de consigne (− / +) */
  .az-step {
    display: inline-flex;
    width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    background: var(--color-card);
    color: var(--color-fg);
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      border-color var(--duration-fast) var(--ease-default),
      transform var(--duration-fast) var(--ease-default);
  }
  .az-step:hover {
    border-color: var(--color-border-strong);
  }
  .az-step:active {
    transform: scale(0.92);
  }
</style>
