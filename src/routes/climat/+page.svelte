<script lang="ts">
  import { daikin } from '$stores/daikin.svelte';
  import { airzone } from '$stores/airzone.svelte';
  import type { AirzoneMode } from '$stores/airzone.svelte';
  import type { DaikinOperationMode, DaikinUnit, FanSpeed, SwingMode } from '$stores/daikin.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';
  import { onMount, onDestroy } from 'svelte';
  import TempGauge from '$components/ui/TempGauge.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ThermostatCard from '$components/cards/ThermostatCard.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { preferences } from '$stores/preferences.svelte';

  onMount(() => {
    zigbee.connect();
    daikin.connect();
    airzone.connect();
    weather.connect();
    thermostat.connect();
  });
  onDestroy(() => {
    zigbee.disconnect();
    daikin.disconnect();
    airzone.disconnect();
    weather.disconnect();
    thermostat.disconnect();
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

  // Gainable : seuls Arrêt / Chaud / Froid. Mode GLOBAL piloté par Parents.
  const GAINABLE_MODES: AirzoneMode[] = ['stop', 'heating', 'cooling'];

  // Animation des icônes de fond Airzone (flocon/flamme) — gated sur la préférence
  // (+ @media reduced-motion en CSS) ; tourne quand la zone refroidit/chauffe vraiment.
  const animOn = $derived(preferences.animationsEnabled);

  // Thermomètres Zigbee (SNZB-02 etc.) — détectés par 'thermo' dans le nom.
  // « Thermo Salon » / « Thermo SdB » sont déjà dans les cartes Daikin / Sèche-
  // serviette, et « thermo_cumulus » dans la carte Cumulus (/energie) → on les
  // exclut de la grille pour éviter le doublon.
  const THERMOS_IN_CARDS = new Set(['thermo salon', 'thermo sdb', 'thermo_cumulus']);
  const thermoSensors = $derived(
    zigbee.devices.filter(
      (d) =>
        d.category === 'sensor' &&
        d.friendlyName.toLowerCase().includes('thermo') &&
        !THERMOS_IN_CARDS.has(d.friendlyName.toLowerCase())
    )
  );
  // Renommage d'AFFICHAGE des thermomètres (le friendlyName Zigbee réel est intact).
  const THERMO_DISPLAY: Record<string, string> = {
    'thermo garage': 'Atelier',
    thermo_ext: 'Terrasse Ouest',
    thermo_velos: 'Local Vélos'
  };
  const thermoDisplayName = (fn: string): string => THERMO_DISPLAY[fn.toLowerCase()] ?? fn;

  // Direction du vent : degrés (météo réelle Open-Meteo) → cardinal FR.
  function windCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

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
    // Ne vibrer QUE si une commande part réellement (sinon faux retour haptique
    // quand l'unité n'est ni en chaud ni en froid).
    if (u.operationMode === 'heating') {
      haptic('light');
      daikin.setTargetHeating(u.id, v);
    } else if (u.operationMode === 'cooling') {
      haptic('light');
      daikin.setTargetCooling(u.id, v);
    }
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

  const conditionLabel: Record<string, string> = {
    clear: 'Dégagé',
    'partly-cloudy': 'Partiellement nuageux',
    cloudy: 'Couvert',
    rain: 'Pluie',
    thunderstorm: 'Orage'
  };

  function fmtDayShort(date: Date): string {
    return date.toLocaleDateString('fr-FR', { weekday: 'short' });
  }

  // ─── Météo : échelle UV (OMS) + couleurs locales des icônes SVG ───────────
  // Pastille UV colorée selon le risque (vert→violet) : compréhensible sans
  // connaître l'échelle. oklch direct (pas de var()).
  function uvInfo(uv: number): { label: string; bg: string; fg: string } {
    if (uv <= 2) return { label: 'Faible', bg: 'oklch(0.68 0.16 145)', fg: 'oklch(0.99 0 0)' };
    if (uv <= 5) return { label: 'Modéré', bg: 'oklch(0.82 0.16 92)', fg: 'oklch(0.32 0.06 92)' };
    if (uv <= 7) return { label: 'Élevé', bg: 'oklch(0.7 0.18 50)', fg: 'oklch(0.99 0 0)' };
    if (uv <= 10) return { label: 'Très élevé', bg: 'oklch(0.62 0.22 27)', fg: 'oklch(0.99 0 0)' };
    return { label: 'Extrême', bg: 'oklch(0.56 0.2 312)', fg: 'oklch(0.99 0 0)' };
  }
  const uvNow = $derived(uvInfo(weather.uvIndex));
  const TEMP_HOT = 'oklch(0.68 0.16 48)'; // température max — orange chaud
  const TEMP_COLD = 'oklch(0.62 0.11 245)'; // température min — bleu froid
  const RAIN_BLUE = 'oklch(0.6 0.13 245)'; // pluie / humidité (icônes)
</script>

<svelte:head>
  <title>Climat — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Climat</h1>
    <span class="text-[12px]" style="color: var(--color-muted-fg);"> Sanguinet </span>
  </header>

  <!-- ═══ Section 2 : Daikin — dial circulaire central ═══ -->
  <section>
    <h2
      class="mb-3 text-[14px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Climatisation / Chauffage
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

          <!-- Tout logé dans les 4 coins morts de l'arc : titre + toggle (flancs hauts),
               orientation (flancs bas). Plus aucune rangée dédiée → carte compacte. -->
          <div class="relative z-10">
            <header class="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2.5">
                <span
                  class="h-2 w-2 shrink-0 rounded-full"
                  style:background-color={unit.online
                    ? 'var(--color-battery)'
                    : 'var(--color-alert)'}
                  title={unit.online ? 'En ligne' : 'Hors ligne'}
                  aria-hidden="true"
                ></span>
                <span
                  class="truncate text-[15px] leading-tight font-semibold"
                  style="color: var(--color-fg);"
                >
                  {unit.zone}
                </span>
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

            <div class="-mb-10 flex items-center justify-center">
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

            <!-- Orientation : nichée dans les flancs bas de l'arc (label supprimé) -->
            <button
              type="button"
              onclick={() => tapSwingH(unit.id, unit.swingHorizontal === 'swing' ? 'off' : 'swing')}
              disabled={!active}
              class="swing-btn absolute bottom-1 left-0 z-20"
              class:swing-active={unit.swingHorizontal === 'swing'}
              aria-pressed={unit.swingHorizontal === 'swing'}
              title="Oscillation horizontale"
            >
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
              class="swing-btn absolute right-0 bottom-1 z-20"
              class:swing-active={unit.swingVertical === 'swing'}
              aria-pressed={unit.swingVertical === 'swing'}
              title="Oscillation verticale"
            >
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

          <!-- Métadonnées : intérieur + extérieur — icône + valeur sur une ligne -->
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
                style="color: {modeColor};"
                aria-hidden="true"
              >
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              {#if indoorT !== null}
                <div class="flex items-baseline gap-1">
                  <span
                    class="text-[17px] font-semibold tabular-nums"
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
                <span
                  class="text-[17px] font-semibold tabular-nums"
                  style="color: var(--color-muted-fg); letter-spacing: -0.01em;"
                >
                  —°
                </span>
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
                <!-- Maison sous le soleil = « extérieur » (façade + astre en coin) -->
                <path d="m2 13 7-5.5 7 5.5" />
                <path d="M4 11.5V20h10v-8.5" />
                <circle cx="18.5" cy="5.5" r="2" />
                <path
                  d="M18.5 1.5v1M18.5 9.5v-1M14.5 5.5h1M22.5 5.5h-1M15.7 2.7l.7.7M21.3 8.3l-.7-.7"
                />
              </svg>
              <span
                class="text-[17px] font-semibold tabular-nums"
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
        </article>
      {/each}

      <!-- Sèche-serviette : remonté à côté du dial Daikin (même grille). -->
      <ThermostatCard />
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

    <!-- Sélecteur de mode GLOBAL — Arrêt / Chaud / Froid, piloté par Parents (directeur) -->
    <div class="flex gap-2">
      {#each GAINABLE_MODES as m (m)}
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
        {@const heat = airzone.systemMode === 'heating'}
        {@const cool = airzone.systemMode === 'cooling'}
        {@const accent = heat
          ? 'var(--color-hp)'
          : cool
            ? 'var(--color-consumption)'
            : 'var(--color-muted-fg)'}
        {@const iconColor = !zone.on ? 'var(--color-muted-fg)' : accent}
        <article
          class="az-zone relative flex flex-col gap-2.5 overflow-hidden rounded-[var(--radius-xl)] border p-4"
          style="background: var(--color-card); border-color: {zone.on
            ? accent
            : 'var(--color-border)'};"
        >
          <!-- Icône de fond = fonction qui s'activera à l'allumage (flocon = froid,
               flamme = chaud) selon le mode système piloté par Parents ; grise en
               transparence quand la pièce est éteinte, colorée quand elle fonctionne. -->
          {#if cool || heat}
            <svg
              class="az-zone-bg"
              class:az-spin={cool && zone.demand && animOn}
              class:az-flame={heat && zone.demand && animOn}
              viewBox="0 0 24 24"
              fill={heat ? 'currentColor' : 'none'}
              stroke={heat ? 'none' : 'currentColor'}
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              style="color: {iconColor}; opacity: {zone.on ? 0.5 : 0.12};"
              aria-hidden="true"
            >
              {#if cool}
                <line x1="2" x2="22" y1="12" y2="12" />
                <line x1="12" x2="12" y1="2" y2="22" />
                <path d="m20 16-4-4 4-4" />
                <path d="m4 8 4 4-4 4" />
                <path d="m16 4-4 4-4-4" />
                <path d="m8 20 4-4 4 4" />
              {:else}
                <path
                  d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
                />
              {/if}
            </svg>
          {/if}

          <!-- Contenu au-dessus de l'icône -->
          <div class="relative z-[1] flex flex-col gap-2.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="text-[14px] font-semibold" style="color: var(--color-fg);">
                  {zone.name}
                </span>
                {#if zone.demand}
                  <span
                    class="rounded-full px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.06em] uppercase"
                    style="color: {accent}; background: color-mix(in oklab, {accent} 18%, transparent);"
                  >
                    actif
                  </span>
                {/if}
              </div>
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

            <div class="flex items-baseline gap-2">
              <div class="flex items-baseline gap-0.5">
                <span
                  class="text-[32px] leading-none font-bold tabular-nums"
                  style="color: var(--color-fg); letter-spacing: -0.02em;"
                >
                  {zone.roomTemp !== null ? zone.roomTemp.toFixed(1) : '—'}
                </span>
                <span class="text-[14px] font-medium" style="color: var(--color-muted-fg);">°C</span
                >
              </div>
              {#if zone.humidity !== null}
                <span class="text-[13px] tabular-nums" style="color: var(--color-consumption);">
                  {Math.round(zone.humidity)}%
                </span>
              {/if}
            </div>

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
                    airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) - (zone.tempStep ?? 0.5));
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
                    airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) + (zone.tempStep ?? 0.5));
                  }}>+</button
                >
              </div>
            </div>

            {#if zone.battery !== null}
              <div class="flex justify-end text-[10px]" style="color: var(--color-muted-fg);">
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
              </div>
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
          <ZigbeeSensorTile {device} name={thermoDisplayName(device.friendlyName)} compact />
        {/each}
      </div>
    </section>
  {/if}

  <!-- ═══ Icône météo SVG (charte) — 5 conditions ═══ -->
  {#snippet weatherIcon(cond: string, size: number)}
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style="display: block; flex-shrink: 0;"
    >
      {#if cond === 'clear'}
        <circle cx="12" cy="12" r="4.6" fill="var(--color-solar)" />
        <g stroke="var(--color-solar)" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="1.5" x2="12" y2="4.2" />
          <line x1="12" y1="19.8" x2="12" y2="22.5" />
          <line x1="1.5" y1="12" x2="4.2" y2="12" />
          <line x1="19.8" y1="12" x2="22.5" y2="12" />
          <line x1="4.6" y1="4.6" x2="6.5" y2="6.5" />
          <line x1="17.5" y1="17.5" x2="19.4" y2="19.4" />
          <line x1="4.6" y1="19.4" x2="6.5" y2="17.5" />
          <line x1="17.5" y1="6.5" x2="19.4" y2="4.6" />
        </g>
      {:else if cond === 'partly-cloudy'}
        <circle cx="9" cy="8.5" r="3.1" fill="var(--color-solar)" />
        <g stroke="var(--color-solar)" stroke-width="1.6" stroke-linecap="round">
          <line x1="9" y1="2.2" x2="9" y2="3.8" />
          <line x1="2.6" y1="8.5" x2="4.2" y2="8.5" />
          <line x1="4.5" y1="4" x2="5.6" y2="5.1" />
          <line x1="13.5" y1="4" x2="12.4" y2="5.1" />
        </g>
        <g fill="var(--color-muted-fg)">
          <circle cx="11" cy="15" r="3.2" />
          <circle cx="15" cy="13.3" r="4.2" />
          <circle cx="18" cy="15.4" r="2.7" />
          <rect x="9.2" y="15" width="10.6" height="3.7" rx="1.85" />
        </g>
      {:else if cond === 'rain'}
        <g fill="var(--color-muted-fg)">
          <circle cx="8.5" cy="11" r="3.3" />
          <circle cx="13" cy="9.3" r="4.3" />
          <circle cx="17" cy="11.5" r="2.8" />
          <rect x="6.5" y="11" width="11.3" height="3.7" rx="1.85" />
        </g>
        <g stroke={RAIN_BLUE} stroke-width="2" stroke-linecap="round">
          <line x1="9" y1="16.5" x2="8" y2="20.5" />
          <line x1="13" y1="16.5" x2="12" y2="20.5" />
          <line x1="17" y1="16.5" x2="16" y2="20.5" />
        </g>
      {:else if cond === 'thunderstorm'}
        <g fill="var(--color-muted-fg)">
          <circle cx="8.5" cy="10.5" r="3.3" />
          <circle cx="13" cy="8.8" r="4.3" />
          <circle cx="17" cy="11" r="2.8" />
          <rect x="6.5" y="10.5" width="11.3" height="3.7" rx="1.85" />
        </g>
        <path
          d="M12.7 15 L9.5 20 L11.8 20 L10.8 23.3 L15 17.8 L12.4 17.8 Z"
          fill="var(--color-solar)"
        />
      {:else}
        <g fill="var(--color-muted-fg)">
          <circle cx="8.5" cy="13" r="3.5" />
          <circle cx="13" cy="11.2" r="4.6" />
          <circle cx="17.2" cy="13.6" r="3" />
          <rect x="6.5" y="13" width="11.6" height="4" rx="2" />
        </g>
      {/if}
    </svg>
  {/snippet}

  <!-- ═══ Météo + prévisions — carte unique (refonte lisible non-initié) ═══ -->
  <section
    class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4 lg:flex-row lg:gap-0"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <!-- ── Maintenant + détails ── -->
    <div class="flex flex-col gap-4 lg:flex-1 lg:pr-6">
      <div class="flex items-center justify-between">
        <span
          class="flex items-center gap-1 text-[13px] font-semibold"
          style="color: var(--color-fg);"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-muted-fg)"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M12 21s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10z" />
            <circle cx="12" cy="11" r="2.2" />
          </svg>
          Sanguinet
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">à l'instant</span>
      </div>

      <div class="flex items-center gap-4">
        {@render weatherIcon(weather.condition, 58)}
        <div class="flex flex-col">
          <div class="flex items-start gap-0.5">
            <span
              class="text-[3.25rem] font-semibold"
              style="color: var(--color-fg); line-height: 0.85; letter-spacing: -0.02em;"
            >
              {weather.tempC.toFixed(0)}
            </span>
            <span class="mt-1 text-[18px] font-medium" style="color: var(--color-muted-fg);"
              >°C</span
            >
          </div>
          <span class="mt-1 text-[15px]" style="color: var(--color-muted-fg);">
            {conditionLabel[weather.condition]}
          </span>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2">
        <!-- Humidité -->
        <div
          class="flex flex-col items-center gap-1 rounded-[var(--radius-md)] py-2.5"
          style="background: var(--color-muted);"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2.5C12 2.5 6 9.5 6 14a6 6 0 0 0 12 0C18 9.5 12 2.5 12 2.5Z"
              fill={RAIN_BLUE}
            />
          </svg>
          <span class="text-[15px] font-semibold tabular-nums" style="color: var(--color-fg);">
            {weather.humidity}<span
              class="text-[11px] font-medium"
              style="color: var(--color-muted-fg);">%</span
            >
          </span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">Humidité</span>
        </div>
        <!-- Vent : flèche orientée (provenance) -->
        <div
          class="flex flex-col items-center gap-1 rounded-[var(--radius-md)] py-2.5"
          style="background: var(--color-muted);"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-muted-fg)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            style="transform: rotate({weather.windDirection}deg);"
          >
            <path d="M12 20V5" />
            <path d="M6 11l6-6 6 6" />
          </svg>
          <span class="text-[15px] font-semibold tabular-nums" style="color: var(--color-fg);">
            {weather.windSpeedKmh}<span
              class="text-[11px] font-medium"
              style="color: var(--color-muted-fg);"
            >
              km/h</span
            >
          </span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);"
            >Vent {windCardinal(weather.windDirection)}</span
          >
        </div>
        <!-- UV : pastille couleur (échelle OMS) -->
        <div
          class="flex flex-col items-center gap-1 rounded-[var(--radius-md)] py-2.5"
          style="background: var(--color-muted);"
        >
          <span
            class="flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[12px] font-bold tabular-nums"
            style="background: {uvNow.bg}; color: {uvNow.fg};"
          >
            {weather.uvIndex}
          </span>
          <span class="text-[13px] font-semibold" style="color: var(--color-fg);">UV</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">{uvNow.label}</span>
        </div>
      </div>
    </div>

    <!-- ── Prévisions 3 jours ── -->
    <div
      class="border-t pt-4 lg:flex-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
      style="border-color: var(--color-border);"
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
            class="flex flex-col items-center gap-1.5 rounded-[var(--radius-md)] py-2.5"
            style="background: var(--color-muted);"
          >
            <span class="text-[11px] font-medium capitalize" style="color: var(--color-muted-fg);">
              {fmtDayShort(day.date)}
            </span>
            {@render weatherIcon(day.condition, 30)}
            <div class="flex items-baseline gap-1.5 text-[13px] tabular-nums">
              <span class="font-semibold" style="color: {TEMP_HOT};">{day.tempMax}°</span>
              <span style="color: {TEMP_COLD};">{day.tempMin}°</span>
            </div>
            {#if day.pop > 20}
              <span
                class="flex items-center gap-0.5 text-[10px] font-semibold tabular-nums"
                style="color: {RAIN_BLUE};"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 2.5C12 2.5 6 9.5 6 14a6 6 0 0 0 12 0C18 9.5 12 2.5 12 2.5Z"
                    fill={RAIN_BLUE}
                  />
                </svg>
                {day.pop}%
              </span>
            {:else}
              <span class="text-[10px]" style="visibility: hidden;">·</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </section>
</div>

<style>
  /* ─── Gainable : icône de fond (flocon froid / flamme chaud) par zone ─── */
  .az-zone-bg {
    position: absolute;
    right: -10%;
    top: 50%;
    width: 46%;
    height: auto;
    transform: translateY(-50%);
    transform-origin: center;
    pointer-events: none;
    transition:
      color 280ms ease,
      opacity 280ms ease;
  }
  /* En marche (zone.demand) : flocon qui tourne (froid) / flamme qui vacille (chaud). */
  .az-zone-bg.az-spin {
    animation: az-spin 9s linear infinite;
  }
  .az-zone-bg.az-flame {
    animation: az-flame 1.8s ease-in-out infinite;
  }
  @keyframes az-spin {
    from {
      transform: translateY(-50%) rotate(0deg);
    }
    to {
      transform: translateY(-50%) rotate(360deg);
    }
  }
  @keyframes az-flame {
    0%,
    100% {
      transform: translateY(-50%) scale(1);
    }
    30% {
      transform: translateY(-53%) scale(1.05);
    }
    65% {
      transform: translateY(-48%) scale(0.97);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .az-zone-bg {
      transition: none;
    }
    .az-zone-bg.az-spin,
    .az-zone-bg.az-flame {
      animation: none;
    }
  }

  /* ─── Daikin card : design Tesla/Mysa-inspired ─── */
  .daikin-card {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
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
    position: relative;
    overflow: hidden;
    isolation: isolate;
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
