<script lang="ts">
  /**
   * Carte « Sèche-serviette » — thermostat de la salle de bain.
   *
   * Affiche la température (sonde « Thermo SdB »), le preset actif + sa consigne,
   * la puissance appelée (duty cycle TPI), et permet de choisir un preset / lancer
   * un boost / basculer auto↔manuel. La régulation réelle vit dans le daemon
   * (thermostat-bridge) ; cette carte ne fait qu'AFFICHER + envoyer des consignes
   * via le store `thermostat`. Auto-suffisante (lit le store).
   */
  import { thermostat, type ThermostatPreset } from '$stores/thermostat.svelte';
  import { haptic } from '$utils/haptic';
  import Sparkline from '$components/ui/Sparkline.svelte';

  // Jauge arc 270° — mêmes proportions que CumulusCard (rayon 80, viewBox 180).
  const ARC_RADIUS = 80;
  const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;
  const ARC_LENGTH = ARC_CIRCUMFERENCE * 0.75;

  // Presets affichés (ordre, libellé, couleur token sémantique).
  const PRESETS: { key: ThermostatPreset; label: string; color: string }[] = [
    { key: 'frost', label: 'Hors-gel', color: 'var(--color-consumption)' },
    { key: 'eco', label: 'Éco', color: 'var(--color-success)' },
    { key: 'comfort', label: 'Confort', color: 'var(--color-hp)' },
    { key: 'boost', label: 'Boost', color: 'var(--color-primary)' }
  ];
  const PRESET_LABEL: Record<ThermostatPreset, string> = {
    frost: 'Hors-gel',
    eco: 'Éco',
    comfort: 'Confort',
    boost: 'Boost',
    off: 'Arrêt',
    manual: 'Manuel'
  };

  // Historique glissant de la température SdB (relevés de la session ; on n'ajoute
  // que les variations réelles > 0,05 °C pour ne pas empiler des doublons).
  let tempHistory = $state<number[]>(thermostat.roomTempC != null ? [thermostat.roomTempC] : []);
  $effect(() => {
    const t = thermostat.roomTempC;
    const last = tempHistory[tempHistory.length - 1];
    if (t != null && (last === undefined || Math.abs(t - last) > 0.05)) {
      tempHistory = [...tempHistory, t].slice(-24);
    }
  });

  const duty = $derived(thermostat.dutyCycle ?? 0);
  const dutyPct = $derived(Math.round(duty * 100));
  const tempLabel = $derived(thermostat.roomTempC != null ? thermostat.roomTempC.toFixed(1) : '—');
  const activeColor = $derived(
    PRESETS.find((p) => p.key === thermostat.activePreset)?.color ?? 'var(--color-muted-fg)'
  );
  const override = $derived(thermostat.override);
  const nextTransition = $derived(thermostat.nextTransition);
  const hasSafetyAlert = $derived(thermostat.windowOpen || thermostat.safety !== 'ok');

  function pick(preset: ThermostatPreset) {
    if (!thermostat.connected) return;
    haptic('light');
    thermostat.setPreset(preset);
  }
  function doBoost() {
    if (!thermostat.connected) return;
    haptic('medium');
    thermostat.boost();
  }
  function setMode(mode: 'auto' | 'manual') {
    if (!thermostat.connected) return;
    haptic('light');
    thermostat.setMode(mode);
  }
  function backToPlanning() {
    haptic('light');
    thermostat.clearOverride();
  }
  function fmtTime(d: Date | null): string {
    return d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  }
</script>

<!-- ═══ Sèche-serviette — thermostat SdB ═══ -->
<section
  class="grid grid-cols-1 gap-4 rounded-[var(--radius-2xl)] border p-5 sm:grid-cols-[1fr_auto] sm:items-center"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex flex-col gap-3">
    <!-- Hero : température mesurée -->
    <div>
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Sèche-serviette · Salle de bain
      </span>
      <div class="mt-1 flex items-baseline gap-1.5">
        <span
          class="text-[44px] leading-none font-bold tracking-tight"
          style="color: var(--color-fg); letter-spacing: -0.02em;"
        >
          {tempLabel}
        </span>
        <span class="text-[20px] font-medium" style="color: var(--color-muted-fg);">°C</span>
      </div>
      <div class="mt-1 text-[12px]" style="color: var(--color-muted-fg);">
        {#if thermostat.targetTempC != null}cible {thermostat.targetTempC}°C ·
        {/if}
        {PRESET_LABEL[thermostat.activePreset]}
        {#if thermostat.humidity != null}
          · {thermostat.humidity}% HR{/if}
      </div>
    </div>

    <!-- État de chauffe (lecture seule, piloté par le daemon) + bascule Auto/Manuel -->
    <div
      class="tw-relay flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border px-3 py-2.5"
      class:is-on={thermostat.connected && thermostat.switchOn === true}
      class:is-offline={!thermostat.connected}
      style="background: var(--color-muted); border-color: var(--color-border);"
    >
      <div class="flex items-center gap-2">
        <span class="tw-dot h-2 w-2 shrink-0 rounded-full"></span>
        <div class="flex flex-col">
          <span class="text-[13px] leading-tight font-semibold" style="color: var(--color-fg);">
            {#if !thermostat.connected}Daemon hors ligne{:else if thermostat.switchOn === true}Chauffe{:else}En
              veille{/if}
          </span>
          <span class="text-[10px] leading-tight" style="color: var(--color-muted-fg);">
            {#if thermostat.connected && thermostat.dutyCycle != null}
              Puissance appelée {dutyPct}%
            {:else}
              Régulation TPI
            {/if}
          </span>
        </div>
      </div>
      <div
        class="tw-seg flex shrink-0 rounded-full p-0.5"
        style="background: var(--color-border-strong);"
      >
        <button
          type="button"
          class="tw-seg-btn"
          class:active={thermostat.mode === 'auto'}
          data-no-haptic
          disabled={!thermostat.connected}
          onclick={() => setMode('auto')}
        >
          Auto
        </button>
        <button
          type="button"
          class="tw-seg-btn"
          class:active={thermostat.mode === 'manual'}
          data-no-haptic
          disabled={!thermostat.connected}
          onclick={() => setMode('manual')}
        >
          Manuel
        </button>
      </div>
    </div>

    <!-- Sélecteur de presets -->
    <div class="grid grid-cols-4 gap-2">
      {#each PRESETS as p (p.key)}
        <button
          type="button"
          class="tw-preset"
          class:active={thermostat.activePreset === p.key}
          style="--preset-color: {p.color};"
          data-no-haptic
          disabled={!thermostat.connected}
          onclick={() => pick(p.key)}
        >
          {p.label}
        </button>
      {/each}
    </div>

    <!-- Boost + retour planning -->
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="tw-boost" disabled={!thermostat.connected} onclick={doBoost}>
        ⚡ Boost
      </button>
      {#if override}
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          Forcé : {PRESET_LABEL[override.preset]}{#if override.until}
            jusqu'à {fmtTime(override.until)}{/if}
        </span>
        <button type="button" class="tw-link" onclick={backToPlanning}>Revenir au planning</button>
      {/if}
    </div>

    <!-- Raison du planning (mode auto) -->
    {#if thermostat.connected && thermostat.mode === 'auto' && thermostat.reason}
      <div
        class="rounded-[var(--radius-md)] border-l-2 px-3 py-1.5 text-[12px]"
        style="background: var(--color-muted); border-color: var(--color-primary); color: var(--color-muted-fg);"
      >
        <span style="color: var(--color-fg);">{thermostat.reason}</span>
        {#if nextTransition}
          <span> → {PRESET_LABEL[nextTransition.preset]} à {fmtTime(nextTransition.at)}</span>
        {/if}
      </div>
    {/if}

    <!-- Sécurité : fenêtre ouverte / sonde perdue / sécurité haute -->
    {#if hasSafetyAlert}
      <div
        class="flex items-center justify-between rounded-[var(--radius-md)] border-l-2 px-3 py-1.5 text-[12px]"
        style="background: var(--color-alert-muted); border-color: var(--color-alert); color: var(--color-alert);"
      >
        <span class="font-medium">
          {#if thermostat.windowOpen}Fenêtre ouverte détectée — chauffe suspendue
          {:else if thermostat.safety === 'sensor_lost'}Sonde « Thermo SdB » injoignable
          {:else if thermostat.safety === 'over_max'}Sécurité haute atteinte
          {:else}Anomalie de régulation{/if}
        </span>
      </div>
    {/if}

    <!-- Sparkline 24h -->
    <div class="flex flex-col gap-1">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Température 24h
      </span>
      <Sparkline data={tempHistory} color="var(--color-hp)" height={28} />
    </div>
  </div>

  <!-- Jauge arc 270° — puissance appelée (duty cycle TPI) -->
  <div class="flex flex-col items-center justify-center">
    <svg viewBox="0 0 180 180" class="h-44 w-44 sm:h-52 sm:w-52" aria-hidden="true">
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
        stroke={activeColor}
        stroke-width="10"
        stroke-dasharray="{ARC_LENGTH * duty} {ARC_CIRCUMFERENCE}"
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
        {dutyPct}%
      </text>
      <text
        x="90"
        y="102"
        text-anchor="middle"
        font-size="11"
        font-weight="500"
        fill="var(--color-muted-fg)"
      >
        puissance
      </text>
    </svg>
    <div class="mt-2 flex gap-4 text-[11px]" style="color: var(--color-muted-fg);">
      <span>{PRESET_LABEL[thermostat.activePreset]}</span>
      {#if thermostat.targetTempC != null}
        <span class="opacity-50">·</span>
        <span>cible {thermostat.targetTempC}°C</span>
      {/if}
    </div>
  </div>
</section>

<style>
  /* Pastille d'état de chauffe */
  .tw-dot {
    background: var(--color-muted-fg);
    transition:
      background 200ms ease,
      box-shadow 200ms ease;
  }
  .tw-relay.is-on .tw-dot {
    background: var(--color-hp);
    box-shadow: 0 0 7px var(--color-hp);
  }
  .tw-relay.is-offline .tw-dot {
    background: var(--color-muted-fg);
    opacity: 0.5;
  }

  /* Segmented Auto / Manuel */
  .tw-seg-btn {
    padding: 0.25rem 0.6rem;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
    cursor: pointer;
    transition:
      background 180ms ease,
      color 180ms ease;
  }
  .tw-seg-btn.active {
    background: var(--color-card);
    color: var(--color-fg);
  }
  .tw-seg-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Boutons preset */
  .tw-preset {
    padding: 0.5rem 0.25rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition:
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease;
  }
  .tw-preset.active {
    border-color: var(--preset-color);
    background: color-mix(in oklch, var(--preset-color) 16%, transparent);
    color: var(--preset-color);
  }
  .tw-preset:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Boost */
  .tw-boost {
    padding: 0.4rem 0.85rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 180ms ease;
  }
  .tw-boost:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Lien « revenir au planning » */
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
    .tw-dot,
    .tw-seg-btn,
    .tw-preset,
    .tw-boost {
      transition: none;
    }
  }
</style>
