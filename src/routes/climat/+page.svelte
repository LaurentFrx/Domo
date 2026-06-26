<script lang="ts">
  import { daikin } from '$stores/daikin.svelte';
  import { airzone } from '$stores/airzone.svelte';
  import type { DaikinOperationMode, DaikinUnit, FanSpeed, SwingMode } from '$stores/daikin.svelte';
  import { weather } from '$stores/weather.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';
  import { onMount, onDestroy } from 'svelte';
  import { acquire } from '$stores/refcount';
  import ClimateDial from '$components/cards/ClimateDial.svelte';
  import ClimateAura from '$components/climate/ClimateAura.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ThermostatCard from '$components/cards/ThermostatCard.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { openTempHistory } from '$stores/temp-history.svelte';

  // Stores page-scoped refcountés (cf. $stores/refcount) — partagés avec les pages
  // voisines du pager sans couper le polling au démontage de l'une d'elles.
  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [
      acquire(zigbee),
      acquire(daikin),
      acquire(airzone),
      acquire(weather),
      acquire(thermostat)
    ];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });

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
  // Consigne réglée au +/− : débouncé côté store → 1 seule commande Onecta par
  // rafale de taps (l'écran suit instantanément grâce à l'optimiste du store).
  const TGT_STEP = 0.5;
  function stepTarget(u: DaikinUnit, dir: 1 | -1) {
    const base = currentTarget(u) ?? u.targetHeating;
    haptic('light');
    daikin.setTargetDebounced(u.id, base + dir * TGT_STEP);
  }
  // Sélecteur Chaud/Froid : un tap bascule le mode opérationnel.
  function tapMode(u: DaikinUnit, mode: Exclude<DaikinOperationMode, 'off'>) {
    if (u.operationMode === mode) return;
    haptic('medium');
    daikin.setOperationMode(u.id, mode);
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
  // Libellé de carte (le bridge renvoie zone:"Daikin" non fiable → on force la pièce).
  const DAIKIN_LABEL: Record<string, string> = {
    daikin: 'Séjour',
    salon: 'Séjour',
    sdb: 'Salle de bain'
  };
  const daikinLabel = (unit: DaikinUnit) => DAIKIN_LABEL[unit.id] ?? unit.zone;
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
    if (uv <= 7) return { label: 'Élevé', bg: 'oklch(0.76 0.19 58)', fg: 'oklch(0.99 0 0)' };
    if (uv <= 10) return { label: 'Très élevé', bg: 'oklch(0.62 0.22 27)', fg: 'oklch(0.99 0 0)' };
    return { label: 'Extrême', bg: 'oklch(0.56 0.2 312)', fg: 'oklch(0.99 0 0)' };
  }
  const uvNow = $derived(uvInfo(weather.uvIndex));
  const TEMP_HOT = 'oklch(0.76 0.18 55)'; // température max — orange chaud lumineux
  const TEMP_COLD = 'oklch(0.62 0.11 245)'; // température min — bleu froid
  const RAIN_BLUE = 'oklch(0.6 0.13 245)'; // pluie / humidité (icônes)
</script>

<div class="flex flex-col gap-6 py-4">
  <!-- ═══ Daikin Séjour + Salle de bain — cartes instrument ═══ -->
  <!-- iPhone portrait : 1 carte/ligne (confort) ; écran large : 2 colonnes. -->
  <section>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <!-- ╔═══════════════════════════════════════════════════════════════════╗
           ║ 🔒 CARTE SÉJOUR (Daikin) — VERROUILLÉE (validée par Laurent 2026-06-20). ║
           ║ NE PAS modifier ce markup ni le CSS associé (.dk-*, .gbtn, .mi, .dk-bar) ║
           ║ ni le rendu de ClimateDial pour le Séjour, SAUF demande EXPLICITE de    ║
           ║ Laurent. Cf. mémoire « domo_climat_sejour_card_locked ».                ║
           ╚═══════════════════════════════════════════════════════════════════╝ -->
      {#each daikin.units as unit (unit.id)}
        {@const thermo = thermoForUnit(unit)}
        {@const thermoKey = DAIKIN_UNIT_THERMO[unit.id] ?? thermo?.friendlyName ?? null}
        {@const indoorT =
          typeof thermo?.state.temperature === 'number'
            ? (thermo.state.temperature as number)
            : null}
        {@const indoorH =
          typeof thermo?.state.humidity === 'number' ? (thermo.state.humidity as number) : null}
        {@const tgt = currentTarget(unit)}
        {@const consigne = tgt ?? unit.targetHeating}
        {@const TGT_MIN = 16}
        {@const TGT_MAX = 30}
        {@const active = unit.onOff && unit.operationMode !== 'off'}
        {@const dHeat = unit.operationMode === 'heating'}
        {@const dCool = unit.operationMode === 'cooling'}
        {@const dAccent = dHeat
          ? 'var(--color-hp)'
          : dCool
            ? 'var(--color-consumption)'
            : 'var(--color-muted-fg)'}
        <article
          class="dk-card relative isolate flex flex-col gap-2 overflow-hidden rounded-[var(--radius-2xl)] p-2.5"
        >
          <!-- Aura d'arrière-plan : flamme (chaud) / flocon (froid) ; s'anime quand
               l'unité est en marche, fantôme quand éteinte. Sans froid si mode off. -->
          <ClimateAura
            heat={dHeat}
            cool={dCool}
            on={unit.onOff}
            demand={unit.onOff && (dHeat || dCool)}
            animate={animOn}
            color={unit.onOff ? dAccent : 'var(--color-muted-fg)'}
            leftPct={27}
          />
          <!-- Haut, une ligne : nom · humidité + extérieur · toggle -->
          <header class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                style:background-color={unit.online ? '#4ade80' : '#f0606a'}
                title={unit.online ? 'En ligne' : 'Hors ligne'}
                aria-hidden="true"
              ></span>
              <span class="dk-name truncate">{daikinLabel(unit)}</span>
            </div>
            <div class="flex shrink-0 items-center gap-2.5">
              <span class="dk-stat c">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2.5C12 2.5 6 9.5 6 14a6 6 0 0 0 12 0C18 9.5 12 2.5 12 2.5Z" />
                </svg>
                {indoorH !== null ? `${Math.round(indoorH)}%` : '—'}
              </span>
              <span class="dk-stat o">
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
                {unit.outdoorTempC.toFixed(1)}°
              </span>
              <button
                type="button"
                data-no-haptic
                class="toggle-track shrink-0"
                class:toggle-on={unit.onOff}
                role="switch"
                aria-checked={unit.onOff}
                aria-label="Allumer / éteindre {daikinLabel(unit)}"
                onclick={() => tapOnOff(unit)}
                disabled={!unit.online}
              >
                <span class="toggle-knob"></span>
              </button>
            </div>
          </header>

          <!-- Cadran (mesure) · oscillations à gauche · Chaud/Froid à droite -->
          <div class="flex items-center justify-between gap-1">
            <div class="flex flex-col gap-1.5">
              <button
                type="button"
                class="gbtn osc"
                class:gbtn-dim={!(active && unit.swingHorizontal === 'swing')}
                onclick={() =>
                  tapSwingH(unit.id, unit.swingHorizontal === 'swing' ? 'off' : 'swing')}
                disabled={!active}
                aria-pressed={unit.swingHorizontal === 'swing'}
                aria-label="Oscillation horizontale"
                title="Oscillation horizontale"
              >
                <svg
                  width="20"
                  height="20"
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
                class="gbtn osc"
                class:gbtn-dim={!(active && unit.swingVertical === 'swing')}
                onclick={() => tapSwingV(unit.id, unit.swingVertical === 'swing' ? 'off' : 'swing')}
                disabled={!active}
                aria-pressed={unit.swingVertical === 'swing'}
                aria-label="Oscillation verticale"
                title="Oscillation verticale"
              >
                <svg
                  width="20"
                  height="20"
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

            <ClimateDial
              value={indoorT}
              target={consigne}
              min={TGT_MIN}
              max={TGT_MAX}
              mode={unit.operationMode}
              on={unit.onOff}
              onActivate={thermoKey
                ? () => openTempHistory(thermoKey, daikinLabel(unit))
                : undefined}
            />

            <div class="flex flex-col gap-1.5" role="group" aria-label="Mode Chaud / Froid">
              {#each operationModes as m (m.id)}
                {@const isActive = unit.operationMode === m.id}
                <button
                  type="button"
                  data-no-haptic
                  class="mi"
                  class:on={isActive}
                  class:warm={m.id === 'heating'}
                  onclick={() => tapMode(unit, m.id)}
                  disabled={!unit.online}
                  aria-pressed={isActive}
                  aria-label={m.label}
                  title={m.label}
                >
                  {#if m.id === 'heating'}
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
                      />
                    </svg>
                  {:else}
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="2" x2="22" y1="12" y2="12" />
                      <line x1="12" x2="12" y1="2" y2="22" />
                      <path d="m20 16-4-4 4-4" />
                      <path d="m4 8 4 4-4 4" />
                      <path d="m16 4-4 4-4-4" />
                      <path d="m8 20 4-4 4 4" />
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          </div>

          <!-- Barre consigne (métal) : − / valeur / + (débouncé) -->
          <div class="dk-bar">
            <button
              type="button"
              data-no-haptic
              class="gbtn"
              class:gbtn-dim={!active}
              onclick={() => stepTarget(unit, -1)}
              disabled={!active}
              aria-label="Baisser la consigne"
            >
              −
            </button>
            <div class="dk-tgt" class:dk-tgt-off={!active}>
              <b>{consigne % 1 ? consigne.toFixed(1) : consigne.toFixed(0)}<i>°</i></b>
              <span>Consigne</span>
            </div>
            <button
              type="button"
              data-no-haptic
              class="gbtn"
              class:gbtn-dim={!active}
              onclick={() => stepTarget(unit, 1)}
              disabled={!active}
              aria-label="Monter la consigne"
            >
              +
            </button>
          </div>

          <!-- Ventilation : Auto / Quiet / 1-5 (comportement inchangé) -->
          <div class="flex flex-col gap-1.5">
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
    </div>
  </section>

  <!-- ═══ Climatisation gainable Airzone (3 zones) ═══ -->
  <section class="flex flex-col gap-3">
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
        <!-- Fond « instrument verre sombre » repris de la carte Séjour (.dk-card) :
             dégradé sombre + bordure bleu pâle + ombre profonde + texte clair. -->
        <article
          class="az-zone dk-card relative flex flex-col gap-2.5 overflow-hidden rounded-[var(--radius-2xl)] p-4"
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
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="h-2 w-2 shrink-0 rounded-full"
                  style:background-color={airzone.connected ? '#4ade80' : '#f0606a'}
                  title={airzone.connected ? 'Système en ligne' : 'Système hors ligne'}
                  aria-hidden="true"
                ></span>
                <span class="text-[14px] font-semibold" style="color: #eef5ff;">
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
              <div class="flex shrink-0 items-center gap-2">
                {#if zone.isMaster}
                  <!-- Chaud / Froid : mode GLOBAL, piloté par la zone maître (Parents) -->
                  <div class="az-mode" role="group" aria-label="Mode Chaud / Froid">
                    <button
                      type="button"
                      data-no-haptic
                      class="az-mode-btn warm"
                      class:on={airzone.systemMode === 'heating'}
                      aria-label="Chaud"
                      aria-pressed={airzone.systemMode === 'heating'}
                      title="Chaud"
                      onclick={() => {
                        if (airzone.systemMode === 'heating') return;
                        haptic('medium');
                        airzone.setMode('heating');
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                        <path
                          d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      data-no-haptic
                      class="az-mode-btn"
                      class:on={airzone.systemMode === 'cooling'}
                      aria-label="Froid"
                      aria-pressed={airzone.systemMode === 'cooling'}
                      title="Froid"
                      onclick={() => {
                        if (airzone.systemMode === 'cooling') return;
                        haptic('medium');
                        airzone.setMode('cooling');
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <line x1="2" x2="22" y1="12" y2="12" />
                        <line x1="12" x2="12" y1="2" y2="22" />
                        <path d="m20 16-4-4 4-4" />
                        <path d="m4 8 4 4-4 4" />
                        <path d="m16 4-4 4-4-4" />
                        <path d="m8 20 4-4 4 4" />
                      </svg>
                    </button>
                  </div>
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

            <!-- Température réelle + consigne sur la MÊME ligne (présentation Séjour) -->
            <div class="relative z-[1] flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-baseline gap-2">
                {#if zone.roomTemp !== null}
                  <button
                    type="button"
                    class="temp-link flex items-baseline gap-0.5"
                    aria-label={`Historique 4 h — ${zone.name}`}
                    onclick={() => openTempHistory(`airzone:${zone.id}`, zone.name)}
                  >
                    <span
                      class="text-[32px] leading-none font-bold tabular-nums"
                      style="color: #eaf3ff; letter-spacing: -0.02em;"
                    >
                      {zone.roomTemp.toFixed(1)}
                    </span>
                    <span class="text-[14px] font-medium" style="color: #9ec2d8;">°C</span>
                  </button>
                {:else}
                  <div class="flex items-baseline gap-0.5">
                    <span
                      class="text-[32px] leading-none font-bold tabular-nums"
                      style="color: #eaf3ff; letter-spacing: -0.02em;">—</span
                    >
                    <span class="text-[14px] font-medium" style="color: #9ec2d8;">°C</span>
                  </div>
                {/if}
                {#if zone.humidity !== null}
                  <span class="text-[13px] tabular-nums" style="color: #7fdcff;">
                    {Math.round(zone.humidity)}%
                  </span>
                {/if}
              </div>

              <div class="dk-bar">
                <button
                  type="button"
                  data-no-haptic
                  class="gbtn"
                  class:gbtn-dim={!zone.on}
                  disabled={!zone.on}
                  aria-label="Baisser la consigne {zone.name}"
                  onclick={() => {
                    haptic('light');
                    airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) - (zone.tempStep ?? 0.5));
                  }}>−</button
                >
                <div class="dk-tgt" class:dk-tgt-off={!zone.on}>
                  <b
                    >{zone.setpoint !== null
                      ? zone.setpoint % 1
                        ? zone.setpoint.toFixed(1)
                        : zone.setpoint.toFixed(0)
                      : '—'}<i>°</i></b
                  >
                  <span>Consigne</span>
                </div>
                <button
                  type="button"
                  data-no-haptic
                  class="gbtn"
                  class:gbtn-dim={!zone.on}
                  disabled={!zone.on}
                  aria-label="Monter la consigne {zone.name}"
                  onclick={() => {
                    haptic('light');
                    airzone.setSetpoint(zone.id, (zone.setpoint ?? 24) + (zone.tempStep ?? 0.5));
                  }}>+</button
                >
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
  </section>

  <!-- ═══ Salle de bain (sèche-serviette) — sous les chambres ═══ -->
  <section>
    <div class="grid grid-cols-1 sm:grid-cols-2">
      <ThermostatCard />
    </div>
  </section>

  <!-- ═══ Thermomètres Zigbee (déplacés depuis /pieces) ═══ -->
  {#if thermoSensors.length > 0}
    <section>
      <div class="grid grid-cols-3 gap-2">
        {#each thermoSensors as device (device.ieee)}
          <ZigbeeSensorTile
            {device}
            name={thermoDisplayName(device.friendlyName)}
            compact
            onActivate={() =>
              openTempHistory(device.friendlyName, thermoDisplayName(device.friendlyName))}
          />
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
    class="flex flex-col gap-2.5 rounded-[var(--radius-2xl)] border p-3 lg:flex-row lg:gap-0"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <!-- ── Maintenant (compact : icône + temp à gauche, lieu à droite) ── -->
    <div class="flex flex-col gap-2 lg:flex-1 lg:pr-6">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-3">
          {@render weatherIcon(weather.condition, 44)}
          <div class="flex flex-col">
            <button
              type="button"
              class="temp-link flex items-start gap-0.5"
              aria-label="Historique 4 h — extérieur (Sanguinet)"
              onclick={() => openTempHistory('meteo:sanguinet', 'Extérieur · Sanguinet')}
            >
              <span
                class="text-[2.3rem] font-semibold"
                style="color: var(--color-fg); line-height: 0.85; letter-spacing: -0.02em;"
              >
                {weather.tempC.toFixed(0)}
              </span>
              <span class="mt-1 text-[14px] font-medium" style="color: var(--color-muted-fg);"
                >°C</span
              >
            </button>
            <span class="mt-0.5 text-[12px]" style="color: var(--color-muted-fg);">
              {conditionLabel[weather.condition]}
            </span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-0.5">
          <span
            class="flex items-center gap-1 text-[12px] font-semibold"
            style="color: var(--color-fg);"
          >
            <svg
              width="12"
              height="12"
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
          <span class="text-[10px]" style="color: var(--color-muted-fg);">à l'instant</span>
        </div>
      </div>

      <!-- Détails sur une seule ligne : humidité · vent · UV -->
      <div
        class="flex items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-2"
        style="background: var(--color-muted);"
      >
        <span class="flex items-center gap-1.5">
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2.5C12 2.5 6 9.5 6 14a6 6 0 0 0 12 0C18 9.5 12 2.5 12 2.5Z"
              fill={RAIN_BLUE}
            />
          </svg>
          <span class="text-[13px] font-semibold tabular-nums" style="color: var(--color-fg);">
            {weather.humidity}<span
              class="text-[10px] font-medium"
              style="color: var(--color-muted-fg);">%</span
            >
          </span>
        </span>
        <span class="flex items-center gap-1.5">
          <svg
            width="15"
            height="15"
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
          <span class="text-[13px] font-semibold tabular-nums" style="color: var(--color-fg);">
            {weather.windSpeedKmh}<span
              class="text-[10px] font-medium"
              style="color: var(--color-muted-fg);"
            >
              km/h</span
            >
          </span>
          <span class="text-[10px]" style="color: var(--color-muted-fg);"
            >{windCardinal(weather.windDirection)}</span
          >
        </span>
        <span class="flex items-center gap-1.5">
          <span
            class="flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
            style="background: {uvNow.bg}; color: {uvNow.fg};"
          >
            {weather.uvIndex}
          </span>
          <span class="text-[10px]" style="color: var(--color-muted-fg);">UV</span>
        </span>
      </div>
    </div>

    <!-- ── Prévisions 3 jours (sans trait de séparation) ── -->
    <div class="lg:flex-1 lg:pl-6">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Prévisions 3 jours
      </span>
      <div class="mt-1.5 grid grid-cols-3 gap-2">
        {#each weather.forecast3d as day (day.date.toISOString())}
          <div
            class="flex flex-col items-center gap-1 rounded-[var(--radius-md)] py-1"
            style="background: var(--color-muted);"
          >
            <span class="text-[11px] font-medium capitalize" style="color: var(--color-muted-fg);">
              {fmtDayShort(day.date)}
            </span>
            {@render weatherIcon(day.condition, 26)}
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
  /* Température cliquable → pop-up historique 4 h (reset bouton, alignement hérité). */
  .temp-link {
    appearance: none;
    border: none;
    background: none;
    margin: 0;
    padding: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* ─── Gainable : icône de fond (flocon froid / flamme chaud) par zone ─── */
  /* Réduite et centrée (entre la température réelle et la consigne), en arrière-plan. */
  .az-zone-bg {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 30%;
    height: auto;
    transform: translate(-50%, -50%);
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
      transform: translate(-50%, -50%) rotate(0deg);
    }
    to {
      transform: translate(-50%, -50%) rotate(360deg);
    }
  }
  @keyframes az-flame {
    0%,
    100% {
      transform: translate(-50%, -50%) scale(1);
    }
    30% {
      transform: translate(-50%, -53%) scale(1.05);
    }
    65% {
      transform: translate(-50%, -48%) scale(0.97);
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

  /* 🔒 VERROUILLÉ — styles de la carte Séjour validés (2026-06-20). Ne pas modifier
     .dk-card / .dk-name / .dk-stat / .gbtn / .mi / .dk-bar / .dk-tgt sans demande
     EXPLICITE de Laurent (la carte Airzone réutilise .dk-bar/.gbtn → en tenir compte). */
  /* ─── Daikin card : instrument verre sombre (cadran ClimateDial) ─── */
  .dk-card {
    color: #e8eefb;
    background: radial-gradient(130% 100% at 50% 16%, #17223a 0%, #0a1020 50%, #05080f 100%);
    border: 1px solid rgba(120, 160, 255, 0.1);
    /* Contour « plexiglass » de l'app (arête bleue HG / ombre verte BD) + relief sombre. */
    box-shadow:
      var(--shadow-md),
      0 24px 64px rgba(0, 0, 0, 0.62),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  .dk-name {
    font-size: 15px;
    font-weight: 600;
    color: #eef5ff;
  }
  .dk-stat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .dk-stat.c {
    color: #7fdcff;
  }
  .dk-stat.o {
    color: #ffc46b;
  }

  /* Boutons glossy bombés (oscillation + − / +) — reflet, AUCUN halo flou */
  .gbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.28);
    color: #f2fbff;
    font-size: 19px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    background: radial-gradient(circle at 36% 26%, #9be2ff 0%, #33a6ea 44%, #1772c2 100%);
    box-shadow:
      0 2px 5px rgba(0, 0, 0, 0.45),
      inset 0 3px 7px rgba(255, 255, 255, 0.5),
      inset 0 -8px 12px rgba(0, 45, 95, 0.5);
    transition: transform var(--duration-fast) var(--ease-default);
  }
  .gbtn:active:not(:disabled) {
    transform: scale(0.94);
  }
  .gbtn:disabled {
    cursor: not-allowed;
  }
  .gbtn.gbtn-dim {
    color: #aebbd2;
    border-color: rgba(255, 255, 255, 0.12);
    background: radial-gradient(circle at 36% 26%, #384057 0%, #1b2436 60%, #101622 100%);
    box-shadow:
      0 2px 4px rgba(0, 0, 0, 0.4),
      inset 0 3px 7px rgba(255, 255, 255, 0.1),
      inset 0 -8px 12px rgba(0, 0, 0, 0.45);
  }
  .gbtn.osc {
    width: 46px;
    height: 46px;
    border-radius: 12px;
  }
  .gbtn.osc svg {
    width: 20px;
    height: 20px;
  }

  /* Sélecteur Chaud / Froid — boutons empilés (verre), cible tactile ≥ 44 px */
  .mi {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 56px;
    min-height: 44px;
    padding: 6px 12px;
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
  .mi:active:not(:disabled) {
    transform: scale(0.95);
  }
  .mi:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .mi.on {
    background: rgba(60, 180, 255, 0.2);
    color: #9fe6ff;
    border-color: rgba(120, 200, 255, 0.45);
  }
  .mi.warm.on {
    background: rgba(255, 168, 80, 0.2);
    color: #ffce9a;
    border-color: rgba(255, 180, 90, 0.45);
  }

  /* Barre consigne — métal brossé (marges verticales contenues) */
  .dk-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 12px;
    border-radius: 15px;
    background: linear-gradient(180deg, #4a5165 0%, #2a3142 32%, #1b2130 62%, #3b4354 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      inset 0 -3px 7px rgba(0, 0, 0, 0.45);
  }
  .dk-bar .gbtn {
    width: 38px;
    height: 38px;
  }
  .dk-tgt {
    text-align: center;
    line-height: 1;
  }
  .dk-tgt b {
    font-size: 20px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: #eef5ff;
  }
  .dk-tgt b i {
    font-size: 11px;
    font-style: normal;
    color: #7fdcff;
    vertical-align: top;
  }
  .dk-tgt span {
    display: block;
    font-size: 9px;
    letter-spacing: 0.1em;
    color: #aeb9cd;
  }
  .dk-tgt-off b,
  .dk-tgt-off b i {
    color: #8493ab;
  }

  /* Airzone — Chaud / Froid (icônes) sur la zone maître (Parents) */
  .az-mode {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 9px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
  }
  .az-mode-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 26px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .az-mode-btn svg {
    width: 16px;
    height: 16px;
  }
  .az-mode-btn:active {
    transform: scale(0.92);
  }
  .az-mode-btn.on {
    background: var(--color-consumption-muted);
    color: var(--color-consumption);
  }
  .az-mode-btn.warm.on {
    background: var(--color-hp-muted);
    color: var(--color-hp);
  }

  /* Ventilation : segments verre sombre */
  .fan-seg {
    flex: 1;
    padding: 0.4rem 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.04);
    color: #8c9bb5;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .fan-seg:hover:not(:disabled) {
    border-color: rgba(255, 255, 255, 0.28);
    color: #d6e2f5;
  }
  .fan-seg:active:not(:disabled) {
    transform: scale(0.97);
  }
  .fan-seg:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .fan-seg-active {
    border-color: rgba(120, 200, 255, 0.5);
    background: rgba(60, 180, 255, 0.18);
    color: #bfe9ff;
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
