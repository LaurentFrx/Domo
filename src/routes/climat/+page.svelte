<script lang="ts">
  import type { CumulusMode } from '$theme/tokens';
  import { cumulus } from '$stores/cumulus.svelte';
  import { daikin } from '$stores/daikin.svelte';
  import type { DaikinMode, DaikinUnit } from '$stores/daikin.svelte';
  import { weather } from '$stores/weather.svelte';
  import { daysUntil } from '$utils/mock-curves';
  import { haptic } from '$utils/haptic';
  import Sparkline from '$components/ui/Sparkline.svelte';

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
  const daikinModes: { id: DaikinMode; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'heat', label: 'Chaud' },
    { id: 'cool', label: 'Froid' },
    { id: 'fan', label: 'Ventil' },
    { id: 'off', label: 'Off' }
  ];

  function decrTarget(u: DaikinUnit) {
    haptic('light');
    daikin.setTarget(u.id, u.target - 0.5);
  }
  function incrTarget(u: DaikinUnit) {
    haptic('light');
    daikin.setTarget(u.id, u.target + 0.5);
  }

  function tapCumulusMode(mode: typeof cumulus.currentMode) {
    haptic('medium');
    cumulus.setMode(mode);
  }
  function tapDaikinMode(unitId: string, mode: DaikinMode) {
    haptic('light');
    daikin.setMode(unitId, mode);
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

  <!-- ═══ Section 2 : Daikin ═══ -->
  <section>
    <h2
      class="mb-3 text-[14px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Climatisation / Chauffage Daikin
    </h2>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {#each daikin.units as unit (unit.id)}
        <article
          class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <div class="flex items-center justify-between">
            <div>
              <span class="text-[14px] font-semibold">{unit.zone}</span>
              <div class="text-[11px]" style="color: var(--color-muted-fg);">
                {unit.name}
              </div>
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style="
                background: {unit.online ? 'var(--color-battery-muted)' : 'var(--color-alert-muted)'};
                color: {unit.online ? 'var(--color-battery)' : 'var(--color-alert)'};
              "
            >
              {unit.online ? 'En ligne' : 'Hors ligne'}
            </span>
          </div>

          <!-- Temp ambient -->
          <div class="flex items-baseline gap-3">
            <div>
              <span
                class="text-[10px] font-semibold tracking-[0.04em] uppercase"
                style="color: var(--color-muted-fg);"
              >
                Ambiante
              </span>
              <div class="flex items-baseline gap-0.5">
                <span class="text-[28px] font-semibold" style="color: var(--color-fg); letter-spacing: -0.01em;">
                  {unit.ambient.toFixed(1)}
                </span>
                <span class="text-[14px]" style="color: var(--color-muted-fg);">°C</span>
              </div>
            </div>
          </div>

          <!-- Consigne ± -->
          <div class="flex items-center justify-between">
            <span
              class="text-[10px] font-semibold tracking-[0.04em] uppercase"
              style="color: var(--color-muted-fg);"
            >
              Consigne
            </span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => decrTarget(unit)}
                class="flex h-8 w-8 items-center justify-center rounded-full border text-[16px] font-semibold transition-colors"
                style="border-color: var(--color-border); color: var(--color-muted-fg);"
                aria-label="Diminuer la consigne"
              >−</button>
              <span
                class="text-[20px] font-semibold tabular-nums"
                style="color: var(--color-primary);"
              >
                {unit.target.toFixed(1)} °C
              </span>
              <button
                type="button"
                onclick={() => incrTarget(unit)}
                class="flex h-8 w-8 items-center justify-center rounded-full border text-[16px] font-semibold transition-colors"
                style="border-color: var(--color-border); color: var(--color-muted-fg);"
                aria-label="Augmenter la consigne"
              >+</button>
            </div>
          </div>

          <!-- Mode segmented -->
          <div class="flex gap-1.5 overflow-x-auto">
            {#each daikinModes as m (m.id)}
              {@const active = unit.mode === m.id}
              <button
                type="button"
                onclick={() => tapDaikinMode(unit.id, m.id)}
                class="flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors"
                style="
                  min-width: 56px;
                  border-color: {active ? 'var(--color-primary)' : 'var(--color-border)'};
                  background: {active ? 'var(--color-primary-muted)' : 'transparent'};
                  color: {active ? 'var(--color-primary)' : 'var(--color-muted-fg)'};
                "
                aria-pressed={active}
              >
                {m.label}
              </button>
            {/each}
          </div>

          <!-- Footer stats -->
          <div class="flex items-center justify-between text-[11px]" style="color: var(--color-muted-fg);">
            <span>Ventilation : {unit.fanSpeed}</span>
            <span class="tabular-nums">
              {unit.mode === 'off' ? '— W' : `${unit.powerW} W`}
            </span>
          </div>
        </article>
      {/each}
    </div>
  </section>

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
