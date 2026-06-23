<script lang="ts">
  /**
   * Carte « Chauffe-eau » — UI d'OBSERVATION pure.
   *
   * Ne change RIEN à la logique : decide.ts / relay.ts / energy-model.ts /
   * observationMode INTACTS. Elle ne fait qu'AFFICHER l'état et conserver le
   * toggle marche/arrêt MANUEL existant (cumulus.setManualRelay).
   *
   * - Voyant 3 états calé sur la PUISSANCE réelle (EM-50 voie cumulus) :
   *     P > seuil → rouge (chauffe) · relais ON → vert clignotant (alimenté,
   *     température atteinte) · sinon → éteint.
   * - Réserve d'eau chaude estimée (E_avail → « ≈ N douches » + barre).
   * - Stats : température ballon, dernier plein, conso du jour.
   * - Pop-up pédagogique « Comment ça marche ? ».
   *
   * Mobile-first iOS PWA (~380px), skin Yeldra (violet #6E45FF, mint #3DFD98).
   */
  import { onMount } from 'svelte';
  import { cumulus, CUMULUS_ANOMALY_LABELS } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { haptic } from '$utils/haptic';
  import BottomSheet from '$lib/components/ui/BottomSheet.svelte';

  const HEATING_W = 500; // au-dessus → le cumulus chauffe (à comparer au voyant du capot)

  const online = $derived(cumulus.relayConnected);
  const relayOn = $derived(cumulus.relayOn === true);
  // Anomalie remontée par le moteur (relais désync, boîtier injoignable…) : on la
  // MONTRE — l'état affiché ne doit pas mentir si le système a perdu le contrôle.
  const anomalyLabel = $derived(CUMULUS_ANOMALY_LABELS[cumulus.anomaly] || '');
  const cumulusW = $derived(em50.cumulusPowerW);

  // ── Voyant : priorité à la PUISSANCE mesurée ──
  type Voyant = 'heating' | 'supplied' | 'off' | 'offline';
  const voyant = $derived.by((): Voyant => {
    if (!online) return 'offline';
    if (cumulusW > HEATING_W) return 'heating';
    if (relayOn) return 'supplied';
    return 'off';
  });
  const voyantColor = $derived(
    voyant === 'heating'
      ? 'var(--color-hp)'
      : voyant === 'supplied'
        ? 'var(--color-success)'
        : 'var(--color-muted-fg)'
  );
  const statusLine = $derived.by(() => {
    if (voyant === 'offline') return 'Boîtier injoignable';
    if (voyant === 'heating') return `En chauffe · ${(cumulusW / 1000).toFixed(1)} kW`;
    if (voyant === 'supplied') return 'Alimenté · température atteinte';
    return 'Éteint';
  });

  // ── Réserve d'eau chaude (E_avail, observation) ──
  const nDouches = $derived(
    cumulus.showers !== null ? Math.max(0, Math.round(cumulus.showers)) : null
  );
  const fillPct = $derived.by(() => {
    const a = cumulus.eAvailWh;
    const f = cumulus.eFullWh;
    if (a === null || f === null || f <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((a / f) * 100)));
  });
  const reserveKnown = $derived(nDouches !== null && fillPct !== null);

  // ── Stats ──
  const ballonTemp = $derived(
    cumulus.waterTempC !== null ? `${cumulus.waterTempC.toFixed(0)} °C` : '—'
  );
  const consoToday = $derived(`${cumulus.energyTodayKwh.toFixed(2)} kWh`);
  function fmtSince(ts: number | null): string {
    if (ts === null) return 'jamais';
    const h = (Date.now() - ts) / 3_600_000;
    if (h < 1) return `il y a ${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `il y a ${Math.round(h)} h`;
    return `il y a ${Math.round(h / 24)} j`;
  }
  const lastFull = $derived(fmtSince(cumulus.lastAnchorTs));

  // ── Toggle marche/arrêt MANUEL (commande existante, passe par le moteur) ──
  function toggleHeater() {
    if (!online) return;
    haptic('medium');
    cumulus.setManualRelay(!relayOn);
  }

  // ── Pop-up « Comment ça marche ? » ──
  let helpOpen = $state(false);
  const STEPS = [
    {
      t: 'Observer et se calibrer',
      d: 'Domo mesure comment le ballon chauffe, refroidit, et comment on consomme l’eau.',
      current: true
    },
    {
      t: 'Sécurité',
      d: 'Ne jamais lancer la chauffe quand un gros appareil tourne déjà (four, plaques, lave-linge).',
      current: false
    },
    {
      t: 'Chauffe au soleil',
      d: 'Utiliser le surplus solaire de la journée plutôt que de le revendre à perte.',
      current: false
    },
    {
      t: 'Appoint la nuit',
      d: 'S’il manque de l’eau chaude, compléter en heures creuses, au dernier moment et en une fois.',
      current: false
    },
    {
      t: 'Automatique',
      d: 'Une fois calibré, Domo gère tout seul en garantissant l’eau chaude.',
      current: false
    }
  ];

  onMount(() => {
    // Idempotent : la page Énergie connecte déjà ces stores ; filet de sûreté
    // pour que le voyant reste réactif si la carte est placée ailleurs.
    em50.connect();
    cumulus.connectRelay();
    cumulus.connectOrchestrator();
  });
</script>

<section
  class="ce-card relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius-2xl)] border p-5"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Header : voyant + titre/statut + toggle marche/arrêt -->
  <header class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2.5">
      <span class="led" class:blink={voyant === 'supplied'} style="--led: {voyantColor};"></span>
      <div class="min-w-0">
        <div class="text-[15px] font-semibold" style="color: var(--color-fg);">Chauffe-eau</div>
        <div class="text-[12.5px] font-medium" style="color: {voyantColor};">{statusLine}</div>
      </div>
    </div>
    <button
      type="button"
      data-no-haptic
      class="tg-track"
      class:tg-on={relayOn && online}
      role="switch"
      aria-checked={relayOn}
      aria-label="Allumer ou éteindre le chauffe-eau (manuel)"
      disabled={!online}
      onclick={toggleHeater}
    >
      <span class="tg-knob"></span>
    </button>
  </header>

  {#if anomalyLabel}
    <div class="cc-anomaly" role="alert">
      <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
        <path
          d="M12 3.2 1.8 20.4a1 1 0 0 0 .87 1.5h18.66a1 1 0 0 0 .87-1.5L12 3.2Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
        />
        <path
          d="M12 9.5v5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <circle cx="12" cy="17.6" r="1.05" fill="currentColor" />
      </svg>
      <span>{anomalyLabel} — le pilotage automatique peut être affecté.</span>
    </div>
  {/if}

  <!-- Hero : réserve d'eau chaude -->
  <div class="flex flex-col gap-2">
    {#if reserveKnown}
      <div class="flex items-baseline gap-1.5">
        <span class="text-[14px]" style="color: var(--color-muted-fg);">≈</span>
        <span class="text-[42px] leading-none font-bold" style="color: var(--color-fg);"
          >{nDouches}</span
        >
        <span class="text-[15px] font-medium" style="color: var(--color-muted-fg);"
          >{(nDouches ?? 0) > 1 ? 'douches' : 'douche'}</span
        >
      </div>
    {:else}
      <div class="text-[15px] font-medium" style="color: var(--color-muted-fg);">
        Estimation en cours…
      </div>
    {/if}
    <div class="bar"><div class="bar-fill" style="width: {fillPct ?? 0}%;"></div></div>
    <div class="text-[12px]" style="color: var(--color-muted-fg);">
      Réserve d’eau chaude estimée
    </div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat"><span>Température du ballon</span><strong>{ballonTemp}</strong></div>
    <div class="stat"><span>Dernier plein</span><strong>{lastFull}</strong></div>
    <div class="stat"><span>Consommé aujourd’hui</span><strong>{consoToday}</strong></div>
  </div>

  <!-- Aide -->
  <button type="button" class="help-btn" onclick={() => (helpOpen = true)}>
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    Comment ça marche ?
  </button>

  <!-- Pied : mode de pilotage -->
  <div class="text-center text-[11.5px]" style="color: var(--color-muted-fg);">
    Pilotage : manuel (observation)
  </div>
</section>

<BottomSheet open={helpOpen} title="Le pilotage du chauffe-eau" onClose={() => (helpOpen = false)}>
  <p class="intro">
    Domo choisira tout seul les meilleurs moments pour chauffer l’eau : avec le surplus de soleil en
    journée, ou la nuit quand l’électricité est moins chère — en gardant toujours assez d’eau chaude
    et sans surcharger le compteur.
  </p>
  <ol class="steps">
    {#each STEPS as s, i (i)}
      <li class="step" class:current={s.current}>
        <span class="step-num">{i + 1}</span>
        <div class="step-body">
          <div class="step-head">
            <span class="step-title">{s.t}</span>
            {#if s.current}<span class="step-badge">en cours</span>{/if}
          </div>
          <p class="step-desc">{s.d}</p>
        </div>
      </li>
    {/each}
  </ol>
</BottomSheet>

<style>
  /* ── Bandeau d'anomalie : la carte NE MENT PAS si le moteur a perdu le contrôle.
     Ton ambre calme, verre teinté, oklch DIRECT (safe Chrome). ── */
  .cc-anomaly {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-lg);
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.25;
    color: var(--color-fg);
    background: oklch(0.66 0.14 75 / 0.16);
    box-shadow: inset 0 0 0 1px oklch(0.66 0.14 75 / 0.5);
  }
  .cc-anomaly svg {
    flex: 0 0 auto;
    color: oklch(0.6 0.16 60);
  }

  /* ── Voyant LED (glow Chrome-safe : pas de color-mix en box-shadow) ── */
  .led {
    width: 11px;
    height: 11px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--led);
    box-shadow: 0 0 8px 0 var(--led);
  }
  .led.blink {
    animation: led-blink 1.4s ease-in-out infinite;
  }
  @keyframes led-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  /* ── Barre de réserve (mint) ── */
  .bar {
    height: 8px;
    border-radius: 9999px;
    background: var(--color-muted);
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 9999px;
    background: var(--color-success);
    transition: width 700ms var(--ease-out);
  }

  /* ── Stats ── */
  .stats {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--color-border);
  }
  .stat {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0;
  }
  .stat + .stat {
    border-top: 1px solid var(--color-border);
  }
  .stat span {
    font-size: 13px;
    color: var(--color-muted-fg);
  }
  .stat strong {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--color-fg);
  }

  /* ── Bouton aide ── */
  .help-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    align-self: flex-start;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-primary, #6e45ff);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .help-btn svg {
    width: 16px;
    height: 16px;
  }

  /* ── Interrupteur marche/arrêt (repris carte sèche-serviette) ── */
  .tg-track {
    position: relative;
    width: 44px;
    height: 24px;
    flex-shrink: 0;
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

  /* ── Contenu du pop-up ── */
  .intro {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--color-muted-fg);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .step {
    display: flex;
    gap: 0.7rem;
    padding: 0.6rem 0.7rem;
    border-radius: var(--radius-lg, 0.75rem);
    border: 1px solid var(--color-border);
  }
  .step.current {
    border-color: var(--color-success);
    background: color-mix(in oklch, var(--color-success) 12%, transparent);
  }
  .step-num {
    display: grid;
    place-items: center;
    width: 1.6rem;
    height: 1.6rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 13px;
    font-weight: 700;
  }
  .step.current .step-num {
    background: var(--color-success);
    color: oklch(0.2 0.05 152);
  }
  .step-body {
    min-width: 0;
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .step-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .step-badge {
    flex-shrink: 0;
    padding: 0.08rem 0.4rem;
    border-radius: 9999px;
    background: var(--color-success);
    color: oklch(0.2 0.05 152);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .step-desc {
    margin: 0.2rem 0 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--color-muted-fg);
  }

  @media (prefers-reduced-motion: reduce) {
    .led.blink {
      animation: none;
    }
    .bar-fill,
    .tg-knob {
      transition: none;
    }
  }
</style>
