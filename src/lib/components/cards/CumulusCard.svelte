<script lang="ts">
  /**
   * Carte « Cumulus ECS » — état du chauffe-eau (température sonde Zigbee, mode,
   * énergie du jour, anti-légionellose, jauge de chauffe). Auto-suffisante :
   * lit le store `cumulus` (qui dérive lui-même de la sonde Zigbee thermo_cumulus).
   * Extraite de /climat pour pouvoir vivre aussi sur /energie (sous l'électroménager).
   */
  import { cumulus } from '$stores/cumulus.svelte';
  import { daysUntil } from '$utils/mock-curves';
  import { haptic } from '$utils/haptic';
  import Sparkline from '$components/ui/Sparkline.svelte';

  // Jauge arc 270° — rayon 80, centre 90,90 dans un viewBox 180×180.
  const ARC_RADIUS = 80;
  const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;
  const ARC_LENGTH = ARC_CIRCUMFERENCE * 0.75; // 270° = 75 % de la circonférence

  // Historique RÉEL glissant de la température cumulus (relevés sonde Zigbee de la
  // session). Amorcé avec la lecture courante ; on n'ajoute QUE les variations
  // réelles (> 0,05 °C) pour ne pas empiler des doublons à chaque tick réactif.
  let tempHistory = $state<number[]>(cumulus.temperatureC > 0 ? [cumulus.temperatureC] : []);
  $effect(() => {
    const t = cumulus.temperatureC;
    const last = tempHistory[tempHistory.length - 1];
    if (t > 0 && (last === undefined || Math.abs(t - last) > 0.05)) {
      tempHistory = [...tempHistory, t].slice(-24);
    }
  });

  const cumulusProgress = $derived(
    cumulus.targetTempC > 0 ? Math.min(1, cumulus.temperatureC / cumulus.targetTempC) : 0
  );
  const legionnellaDays = $derived(daysUntil(cumulus.nextLegionnellaCycle));

  // Puissance résistance — ESTIMÉE (≈), pas mesurée (le Pro 1 n'a pas de métrologie).
  const powerLabel = $derived(`≈ ${(cumulus.powerW / 1000).toFixed(1).replace('.', ',')} kW`);

  // Bascule du relais réel (Shelly Pro 1). Confirmation par la relecture serveur.
  function toggleRelay() {
    if (!cumulus.relayConnected) return;
    haptic('medium');
    cumulus.setRelay(!(cumulus.relayOn === true));
  }
</script>

<!-- ═══ Cumulus ECS — hero ═══ -->
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

    <!-- Relais cumulus RÉEL (Shelly Pro 1) : état + interrupteur on/off -->
    <div
      class="cum-relay flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border px-3 py-2.5"
      class:is-on={cumulus.relayConnected && cumulus.relayOn === true}
      class:is-offline={!cumulus.relayConnected}
      style="background: var(--color-muted); border-color: var(--color-border);"
    >
      <div class="flex items-center gap-2">
        <span class="cum-dot h-2 w-2 shrink-0 rounded-full"></span>
        <div class="flex flex-col">
          <span class="text-[13px] leading-tight font-semibold" style="color: var(--color-fg);">
            {#if !cumulus.relayConnected}Boîtier hors ligne{:else if cumulus.relayOn === true}Chauffe{:else if cumulus.relayOn === false}Arrêté{:else}…{/if}
          </span>
          <span class="text-[10px] leading-tight" style="color: var(--color-muted-fg);">
            Relais Shelly · {powerLabel}
          </span>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={cumulus.relayOn === true}
        aria-label="Allumer ou éteindre le cumulus"
        data-no-haptic
        class="cum-toggle"
        class:on={cumulus.relayOn === true}
        disabled={!cumulus.relayConnected}
        onclick={toggleRelay}
      >
        <span class="cum-knob"></span>
      </button>
    </div>

    <!-- Barre progression énergie -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between text-[11px]">
        <span style="color: var(--color-muted-fg);">Énergie injectée aujourd'hui</span>
        <span class="font-semibold" style="color: var(--color-fg);">
          {cumulus.energyTodayKwh.toFixed(1)} / {cumulus.energyTargetKwh} kWh
        </span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full" style="background: var(--color-muted);">
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
      <span>{powerLabel}</span>
    </div>
  </div>
</section>

<style>
  /* Pastille d'état du relais */
  .cum-dot {
    background: var(--color-muted-fg);
    transition:
      background 200ms ease,
      box-shadow 200ms ease;
  }
  .cum-relay.is-on .cum-dot {
    background: var(--color-solar);
    box-shadow: 0 0 7px var(--color-solar);
  }

  /* Interrupteur on/off — forme pilule, dans l'esprit des toggles de l'app */
  .cum-toggle {
    position: relative;
    width: 3rem;
    height: 1.625rem;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-border-strong);
    cursor: pointer;
    transition: background 220ms ease;
  }
  .cum-toggle.on {
    background: var(--color-solar);
  }
  .cum-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .cum-knob {
    position: absolute;
    top: 50%;
    left: 0.1875rem;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 9999px;
    background: oklch(0.98 0 0);
    transform: translateY(-50%);
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.3);
    transition: left 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .cum-toggle.on .cum-knob {
    left: calc(100% - 1.4375rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .cum-dot,
    .cum-toggle,
    .cum-knob {
      transition: none;
    }
  }
</style>
