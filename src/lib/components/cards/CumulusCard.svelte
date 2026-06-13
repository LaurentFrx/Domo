<script lang="ts">
  /**
   * Carte « Cumulus ECS » — pilotage du chauffe-eau par l'orchestrateur.
   * Affiche : température (sonde Zigbee), mode (Auto/Manuel/Vacances), raison de
   * la décision du moteur, conso RÉELLE (EM-50), énergie du jour, anomalies, et
   * la jauge de chauffe. Montée sur /energie. Relais + orchestrateur connectés
   * par la page (connectRelay / connectOrchestrator).
   */
  import { cumulus, CUMULUS_REASON_LABELS, CUMULUS_ANOMALY_LABELS } from '$stores/cumulus.svelte';
  import type { CumulusAutoMode } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { haptic } from '$utils/haptic';
  import Sparkline from '$components/ui/Sparkline.svelte';

  // Jauge arc 270° — rayon 80, centre 90,90 dans un viewBox 180×180.
  const ARC_RADIUS = 80;
  const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;
  const ARC_LENGTH = ARC_CIRCUMFERENCE * 0.75; // 270° = 75 % de la circonférence

  const MODES: { id: CumulusAutoMode; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'manual', label: 'Manuel' },
    { id: 'off', label: 'Vacances' }
  ];

  // Historique RÉEL glissant de la température cumulus (relevés sonde Zigbee).
  let tempHistory = $state<number[]>(cumulus.temperatureC > 0 ? [cumulus.temperatureC] : []);
  $effect(() => {
    const t = cumulus.temperatureC;
    const last = tempHistory[tempHistory.length - 1];
    if (t > 0 && (last === undefined || Math.abs(t - last) > 0.05)) {
      tempHistory = [...tempHistory, t].slice(-24);
    }
  });

  // Échelle indicative de la jauge (PAS une cible de régulation : c'est le cumulus qui
  // décide la fin de chauffe). ~62°C ≈ consigne de la molette.
  const GAUGE_MAX_C = 62;
  const cumulusProgress = $derived(Math.min(1, cumulus.temperatureC / GAUGE_MAX_C));

  // ─── Décision du moteur ───────────────────────────────────────────
  const reasonLabel = $derived(
    CUMULUS_REASON_LABELS[cumulus.decisionReason] ?? cumulus.decisionReason
  );
  const anomalyLabel = $derived(CUMULUS_ANOMALY_LABELS[cumulus.anomaly] ?? '');
  const subModeColor = $derived(
    cumulus.decisionSubMode === 'PV'
      ? 'var(--color-solar)'
      : cumulus.decisionSubMode === 'HC'
        ? 'var(--color-hc)'
        : cumulus.decisionSubMode === 'FORCE'
          ? 'var(--color-alert)'
          : 'var(--color-muted-fg)'
  );

  // Ligne d'état lisible (Isabelle) selon le mode.
  const statusLine = $derived(
    cumulus.autoMode === 'off'
      ? 'Chauffe suspendue (vacances)'
      : cumulus.autoMode === 'manual'
        ? cumulus.relayOn === true
          ? 'Marche manuelle'
          : 'Arrêt manuel'
        : reasonLabel
  );

  // ─── Conso RÉELLE mesurée (EM-50 voie cumulus) ────────────────────
  const realPowerW = $derived(em50.available ? Math.round(em50.cumulusPowerW) : null);
  const powerDisplay = $derived(
    realPowerW !== null
      ? realPowerW >= 50
        ? `${(realPowerW / 1000).toFixed(2).replace('.', ',')} kW`
        : '0 W'
      : `≈ ${(cumulus.powerW / 1000).toFixed(1).replace('.', ',')} kW`
  );

  // ─── Énergie cible du jour (config si dispo) ──────────────────────
  const energyTargetKwh = $derived(cumulus.energyTargetKwh || 8);

  // ─── Désinfection (info) : dernière chauffe complète ≥60°C ───
  // Pas de cycle forcé : le thermostat 62°C désinfecte à chaque chauffe complète.
  const disinfectText = $derived.by(() => {
    if (!cumulus.disinfectLastTs) return 'à la 1ʳᵉ chauffe complète';
    const days = Math.floor((Date.now() - cumulus.disinfectLastTs) / 86_400_000);
    if (days <= 0) return "aujourd'hui";
    return `il y a ${days} jour${days > 1 ? 's' : ''}`;
  });

  // ─── Heartbeat du moteur ──────────────────────────────────────────
  const engine = $derived.by(() => {
    if (!cumulus.orchestratorConnected) return { txt: 'moteur hors ligne', ok: false };
    if (cumulus.lastTickTs && Date.now() - cumulus.lastTickTs > 180_000)
      return { txt: 'moteur en pause', ok: false };
    if (cumulus.lastTickTs) return { txt: 'pilotage actif', ok: true };
    return { txt: '', ok: true };
  });

  function toggleRelay() {
    if (!cumulus.relayConnected || cumulus.autoMode === 'off') return;
    haptic('medium');
    cumulus.setManualRelay(!(cumulus.relayOn === true));
  }
  function chooseMode(m: CumulusAutoMode) {
    haptic('light');
    cumulus.setAutoMode(m);
  }
</script>

<!-- ═══ Cumulus ECS — hero ═══ -->
<section
  class="grid grid-cols-1 gap-4 rounded-[var(--radius-2xl)] border p-5 sm:grid-cols-[1fr_auto] sm:items-center"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex flex-col gap-3">
    <div class="flex items-start justify-between gap-2">
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
          {Math.abs(cumulus.trendCh).toFixed(1)} °C/h · eau au point bas
        </div>
      </div>
      <!-- Heartbeat du moteur -->
      {#if engine.txt}
        <div class="flex items-center gap-1.5 text-[10px]" style="color: var(--color-muted-fg);">
          <span
            class="h-1.5 w-1.5 rounded-full"
            style="background: {engine.ok ? 'var(--color-success)' : 'var(--color-muted-fg)'};"
          ></span>
          {engine.txt}
        </div>
      {/if}
    </div>

    <!-- Bandeau anomalie -->
    {#if anomalyLabel}
      <div
        class="rounded-[var(--radius-md)] border-l-2 px-3 py-1.5 text-[12px] font-medium"
        style="background: var(--color-alert-muted); border-color: var(--color-alert); color: var(--color-alert);"
      >
        ⚠ {anomalyLabel}
      </div>
    {/if}

    <!-- Mode de pilotage + raison de décision -->
    <div class="flex flex-col gap-2">
      <div class="cum-modes" role="group" aria-label="Mode de pilotage du cumulus">
        {#each MODES as m (m.id)}
          <button
            type="button"
            class="cum-mode"
            class:active={cumulus.autoMode === m.id}
            data-no-haptic
            onclick={() => chooseMode(m.id)}
          >
            {m.label}
          </button>
        {/each}
      </div>
      <div class="flex items-center gap-2 text-[12px]">
        <span class="cum-reason-dot" style="background: {subModeColor};"></span>
        <span style="color: var(--color-fg);">{statusLine}</span>
      </div>
    </div>

    <!-- Relais cumulus RÉEL (Shelly Pro 1) : état + conso mesurée + interrupteur -->
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
            {cumulus.relayOn === true ? powerDisplay : 'Relais Shelly'}
          </span>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={cumulus.relayOn === true}
        aria-label="Allumer ou éteindre le cumulus (passe en manuel)"
        data-no-haptic
        class="cum-toggle"
        class:on={cumulus.relayOn === true}
        disabled={!cumulus.relayConnected || cumulus.autoMode === 'off'}
        onclick={toggleRelay}
      >
        <span class="cum-knob"></span>
      </button>
    </div>

    <!-- Barre progression énergie (RÉELLE : delta compteur EM-50) -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between text-[11px]">
        <span style="color: var(--color-muted-fg);">Énergie consommée aujourd'hui</span>
        <span class="font-semibold" style="color: var(--color-fg);">
          {cumulus.energyTodayKwh.toFixed(1)} / {energyTargetKwh} kWh
        </span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full" style="background: var(--color-muted);">
        <div
          class="h-full rounded-full transition-all duration-300"
          style="
            width: {Math.min(100, (cumulus.energyTodayKwh / energyTargetKwh) * 100)}%;
            background: var(--color-solar);
          "
        ></div>
      </div>
    </div>

    <!-- Désinfection (chauffe complète ≥60°C) — informatif, pas un cycle forcé -->
    <div
      class="flex items-center justify-between rounded-[var(--radius-md)] border-l-2 px-3 py-1.5 text-[12px]"
      style="background: var(--color-muted); border-color: var(--color-success); color: var(--color-muted-fg);"
    >
      <span class="font-medium">Désinfection (≥60°C)</span>
      <span class="font-semibold tabular-nums" style="color: var(--color-fg);">{disinfectText}</span
      >
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
      <span>{cumulus.relayOn === true ? powerDisplay : 'veille'}</span>
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

  /* Pastille couleur de la raison (sous-mode) */
  .cum-reason-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 9999px;
  }

  /* Sélecteur de mode (Auto / Manuel / Vacances) */
  .cum-modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.25rem;
    padding: 0.1875rem;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
  }
  .cum-mode {
    border-radius: 9999px;
    padding: 0.4rem 0.25rem;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-muted-fg);
    cursor: pointer;
    transition:
      background 200ms ease,
      color 200ms ease;
  }
  .cum-mode.active {
    background: var(--color-card);
    color: var(--color-fg);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.18);
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
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.3);
    transition: left 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .cum-toggle.on .cum-knob {
    left: calc(100% - 1.4375rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .cum-dot,
    .cum-toggle,
    .cum-knob,
    .cum-mode {
      transition: none;
    }
  }
</style>
