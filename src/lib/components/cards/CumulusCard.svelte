<script lang="ts">
  /**
   * Carte « Eau chaude » — familiale ET sobre (calée sur la carte sèche-serviette).
   *
   * Répond à « ai-je assez d'eau chaude ? » sans afficher de degrés (jugés
   * approximatifs). Le cadran fin = RÉSERVE (sa longueur), déduite de la sonde au
   * point bas du ballon. Interrupteur Auto/Vacances en tête, pill « Chauffer
   * maintenant » (boost jusqu'au plein puis retour auto). Aucun watt/kWh/courbe.
   */
  import { cumulus } from '$stores/cumulus.svelte';
  import { haptic } from '$utils/haptic';

  const ARC_R = 80;
  const ARC_C = 2 * Math.PI * ARC_R;
  const ARC_LEN = ARC_C * 0.75; // 270°

  const ready = $derived(cumulus.relayConnected || cumulus.orchestratorConnected);
  const online = $derived(cumulus.relayConnected);
  const isVacances = $derived(cumulus.autoMode === 'off');
  const isHeating = $derived(cumulus.relayOn === true);
  const isBoost = $derived(cumulus.boostUntilFull);

  // Réserve (fraction 0–1 pour le cadran + libellé en mots, sans degrés affichés).
  const reserveFrac = $derived.by(() => {
    const t = cumulus.waterTempC;
    if (t === null) return 0;
    return Math.max(0.04, Math.min(1, (t - 18) / (58 - 18)));
  });
  const reserveLabel = $derived.by(() => {
    const t = cumulus.waterTempC;
    if (t === null) return 'Réserve inconnue';
    if (t >= 50) return 'Eau chaude à volonté';
    if (t >= 43) return 'De quoi vous doucher';
    if (t >= 36) return 'Réserve qui baisse';
    return 'Bientôt à court';
  });
  const isLow = $derived(cumulus.waterTempC !== null && cumulus.waterTempC < 36);

  // État + couleur d'accent (sobres).
  const headline = $derived.by(() => {
    if (!ready) return 'Chargement…';
    if (!online) return 'Hors ligne';
    if (isVacances) return 'Mode vacances';
    if (isHeating) return 'En chauffe';
    return reserveLabel;
  });
  const accent = $derived.by(() => {
    if (!online || isVacances || !ready) return 'var(--color-muted-fg)';
    if (isHeating) return 'var(--color-hp)';
    if (isLow) return 'var(--color-alert)';
    return 'var(--color-success)';
  });
  const arcFrac = $derived(isVacances || !online || !ready ? 0 : reserveFrac);

  const context = $derived.by(() => {
    if (!ready) return '';
    if (!online) return 'Le boîtier ne répond pas';
    if (isVacances) return 'Chauffe suspendue jusqu’à votre retour';
    if (isHeating) {
      switch (cumulus.decisionReason) {
        case 'solar':
          return 'Le soleil chauffe l’eau';
        case 'offpeak_boost':
          return 'Chauffe de nuit, électricité moins chère';
        case 'boost':
          return 'Chauffe lancée à la demande';
        case 'comfort_min':
          return 'L’eau était trop froide';
        default:
          return 'Chauffe en cours';
      }
    }
    return 'Le chauffe-eau se gère tout seul';
  });

  function toggleVacances() {
    if (!online) return;
    haptic('medium');
    cumulus.setAutoMode(isVacances ? 'auto' : 'off');
  }
  function toggleBoost() {
    if (!online) return;
    haptic('medium');
    cumulus.setBoost(!isBoost);
  }
</script>

<section
  class="eau-card relative flex flex-col gap-5 overflow-hidden rounded-[var(--radius-2xl)] border p-5"
  class:is-heating={isHeating}
  style="background: var(--color-card); border-color: {isHeating
    ? 'color-mix(in oklch, var(--color-hp) 45%, var(--color-border))'
    : 'var(--color-border)'}; --halo: {accent};"
>
  <div class="halo" aria-hidden="true"></div>

  <!-- Header : point + titre + interrupteur Auto/Vacances -->
  <header class="relative z-10 flex items-center justify-between">
    <div class="flex items-center gap-2.5">
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        style="background: {online ? 'var(--color-success)' : 'var(--color-alert)'};"
      ></span>
      <span class="text-[15px] font-semibold" style="color: var(--color-fg);">Eau chaude</span>
    </div>
    <button
      type="button"
      data-no-haptic
      class="tg-track"
      class:tg-on={!isVacances && online}
      role="switch"
      aria-checked={!isVacances}
      aria-label="Activer le chauffage de l’eau, ou passer en vacances"
      disabled={!online}
      onclick={toggleVacances}
    >
      <span class="tg-knob"></span>
    </button>
  </header>

  <!-- Cadran héros : réserve (longueur de l'arc), goutte au centre, sans chiffre -->
  <div class="relative z-10 -mb-2 flex items-center justify-center">
    <svg viewBox="0 0 180 180" class="h-40 w-40" aria-label="Réserve : {headline}">
      <circle
        cx="90"
        cy="90"
        r={ARC_R}
        fill="none"
        stroke="var(--color-border)"
        stroke-width="9"
        stroke-dasharray="{ARC_LEN} {ARC_C}"
        stroke-dashoffset={ARC_C * 0.125}
        stroke-linecap="round"
        transform="rotate(90 90 90)"
      />
      <circle
        cx="90"
        cy="90"
        r={ARC_R}
        fill="none"
        stroke={accent}
        stroke-width="9"
        stroke-dasharray="{ARC_LEN * arcFrac} {ARC_C}"
        stroke-dashoffset={ARC_C * 0.125}
        stroke-linecap="round"
        transform="rotate(90 90 90)"
        style="transition: stroke-dasharray 700ms var(--ease-out), stroke 400ms ease;"
      />
      <g transform="translate(90 86)" style="color: {accent}; transition: color 400ms ease;">
        <path
          d="M0 -22 C 0 -22 13 -7 13 3 a 13 13 0 0 1 -26 0 c 0 -10 13 -25 13 -25 z"
          fill="none"
          stroke="currentColor"
          stroke-width="3.2"
          stroke-linejoin="round"
        />
      </g>
    </svg>
  </div>

  <!-- État + contexte -->
  <div class="relative z-10 -mt-2 flex flex-col items-center gap-1 text-center">
    <span class="text-[17px] font-semibold" style="color: var(--color-fg);">{headline}</span>
    {#if context}
      <span class="text-[12.5px]" style="color: var(--color-muted-fg);">{context}</span>
    {/if}
  </div>

  <!-- Action : Chauffer maintenant -->
  <div class="relative z-10 flex">
    <button
      type="button"
      class="eau-pill"
      class:eau-pill-active={isBoost}
      disabled={!online || isVacances}
      aria-pressed={isBoost}
      onclick={toggleBoost}
    >
      {isBoost ? 'Arrêter la chauffe' : 'Chauffer maintenant'}
    </button>
  </div>

  <!-- Chip bas : chauffe effective -->
  <div class="relative z-10 flex">
    <span
      class="info-chip"
      style="border-color: {isHeating
        ? 'color-mix(in oklch, var(--color-hp) 50%, var(--color-border))'
        : 'var(--color-border)'}; color: {isHeating ? 'var(--color-hp)' : 'var(--color-muted-fg)'};"
    >
      <span
        class="dot"
        style="background: {isHeating ? 'var(--color-hp)' : 'var(--color-muted-fg)'};"
      ></span>
      {isHeating ? 'Chauffe en cours' : 'En veille'}
    </span>
  </div>
</section>

<style>
  .eau-card {
    transition: border-color 300ms ease;
  }
  .halo {
    position: absolute;
    right: -40%;
    bottom: -40%;
    width: 120%;
    height: 120%;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      color-mix(in oklch, var(--halo) 18%, transparent) 0%,
      transparent 60%
    );
    opacity: 0;
    transition: opacity 800ms var(--ease-out);
    pointer-events: none;
  }
  .is-heating .halo {
    opacity: 1;
  }

  /* Interrupteur (repris de la carte sèche-serviette) */
  .tg-track {
    position: relative;
    width: 44px;
    height: 24px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
    transition:
      background 220ms ease,
      border-color 220ms ease;
  }
  .tg-on {
    background: var(--color-success);
    border-color: var(--color-success);
  }
  .tg-knob {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.98 0 0);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.3);
    transform: translateY(-50%);
    transition: left 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .tg-on .tg-knob {
    left: calc(100% - 21px);
  }
  .tg-track:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Pill d'action (style pills sèche-serviette) */
  .eau-pill {
    flex: 1;
    padding: 0.7rem 0.5rem;
    border: 1.5px solid var(--color-border);
    border-radius: 9999px;
    background: transparent;
    color: var(--color-fg);
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background 180ms ease,
      border-color 180ms ease,
      transform 120ms ease;
  }
  .eau-pill:active:not(:disabled) {
    transform: scale(0.97);
  }
  .eau-pill:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .eau-pill-active {
    border-color: color-mix(in oklch, var(--color-hp) 55%, var(--color-border));
    background: color-mix(in oklch, var(--color-hp) 14%, transparent);
    color: var(--color-hp);
  }

  /* Chip info bas */
  .info-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.4rem 0.85rem;
    border-radius: 9999px;
    border: 1.5px solid var(--color-border);
    background: var(--color-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
  }

  @media (prefers-reduced-motion: reduce) {
    .eau-card,
    .halo,
    .tg-track,
    .tg-knob,
    .eau-pill {
      transition: none;
    }
  }
</style>
