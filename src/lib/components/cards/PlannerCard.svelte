<script lang="ts">
  /**
   * Carte « Eau chaude » — pilotage + visualisation du PILOTE V2 (règle zéro achat EDF).
   *
   * Trois niveaux de lecture :
   *   1. COUP D'ŒIL  — réserve « ≈ N douches » + jauge + phase du pilote en clair ;
   *   2. AGIR        — Auto / Manuel / Vacances + « Chauffer maintenant » ;
   *   3. COMPRENDRE  — économies, mini-stats, journal du jour (transitions de phase
   *      incluses), et le panneau « détail » exigé par la spec : l'état VRAI/FAUX des
   *      7 conditions d'allumage, le surplus invisible estimé, la production APS et
   *      le potentiel total, le niveau des batteries (+ delta depuis le début de la
   *      chauffe), le compteur d'allumages (spontanés vs reprises), la prochaine action.
   */
  import { cumulus, CUMULUS_ANOMALY_LABELS, PILOT_PHASE_LABELS } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { haptic } from '$utils/haptic';
  import { openTempHistory } from '$stores/temp-history.svelte';

  let showPilot = $state(false);
  let showHelp = $state(false);
  let showAllEvents = $state(false);

  const HEATING_W = 500;
  const EVENTS_FOLDED = 4;

  const online = $derived(cumulus.relayConnected);
  const relayOn = $derived(cumulus.relayOn === true);
  const anomalyLabel = $derived(CUMULUS_ANOMALY_LABELS[cumulus.anomaly] || '');
  const cumulusW = $derived(em50.cumulusPowerW);
  const heatingNow = $derived(cumulusW > HEATING_W);
  const pilot = $derived(cumulus.pilotView);
  const observation = $derived(cumulus.decisionReason === 'observe_only');

  // ── Voyant : priorité à la PUISSANCE mesurée ──
  type Voyant = 'heating' | 'supplied' | 'off' | 'offline';
  const voyant = $derived.by((): Voyant => {
    if (!online) return 'offline';
    if (heatingNow) return 'heating';
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

  // ── Réserve d'eau chaude ──
  const showersRaw = $derived(cumulus.showers);
  const showers = $derived(showersRaw != null ? Math.max(0, Math.round(showersRaw)) : null);
  const eAvail = $derived(cumulus.eAvailWh);
  const eFull = $derived(cumulus.eFullWh);
  const fillPct = $derived(
    eAvail && eFull && eFull > 0 ? Math.min(100, Math.max(0, (eAvail / eFull) * 100)) : 0
  );

  // ── Phase du pilote, en une ligne ──
  const phaseEmoji: Record<string, string> = {
    repos: '😴',
    allumage: '🚀',
    chauffe: '☀️',
    cession: '🤝',
    plein: '✅',
    recharge_hc: '🌙'
  };
  const status = $derived.by((): { line: string; sub: string | null } => {
    if (!pilot)
      return {
        line: heatingNow ? '🔥 Le chauffe-eau chauffe' : '💤 Pilote en attente de données',
        sub: null
      };
    const label = PILOT_PHASE_LABELS[pilot.phase] ?? pilot.phase;
    return {
      line: `${phaseEmoji[pilot.phase] ?? ''} ${label}`,
      sub: pilot.nextAction || null
    };
  });

  // ── Pilotage ──
  const mode = $derived(cumulus.autoMode);
  function setMode(m: 'auto' | 'manual' | 'off') {
    if (m === mode) return;
    haptic('medium');
    cumulus.setAutoMode(m);
  }
  function toggleHeater() {
    if (!online) return;
    haptic('medium');
    cumulus.setManualRelay(!relayOn);
  }
  function toggleBoost() {
    haptic('medium');
    cumulus.setBoost(!cumulus.boostUntilFull);
  }

  // ── Économies (boucle de regret) ──
  const gainToday = $derived(cumulus.regretDay?.gainEur ?? 0);
  const gainWeek = $derived(cumulus.gainWeekEur);
  const fmtEur = (v: number) =>
    `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',')} €`;

  // ── Mini-stats ──
  const ballonTemp = $derived(
    cumulus.waterTempC !== null ? `${cumulus.waterTempC.toFixed(0)} °C` : '—'
  );
  const consoToday = $derived(`${cumulus.energyTodayKwh.toFixed(1)} kWh`);
  function fmtSince(ts: number | null): string {
    if (ts === null) return 'jamais';
    const h = (Date.now() - ts) / 3_600_000;
    if (h < 1) return `il y a ${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `il y a ${Math.round(h)} h`;
    return `il y a ${Math.round(h / 24)} j`;
  }
  const lastFull = $derived(fmtSince(cumulus.lastAnchorTs));

  // ── Journal du jour (transitions de phase incluses) ──
  const hhmm = (ts: number) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const events = $derived.by(() => {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return cumulus.shadowLog
      .filter(
        (e) =>
          e.ts >= start &&
          (e.kind === 'phase' ||
            e.kind === 'heat_end' ||
            e.kind === 'draw' ||
            e.kind === 'full' ||
            e.kind === 'appliance')
      )
      .slice()
      .reverse()
      .map((e) => {
        if (e.kind === 'phase') {
          const emoji = e.label.includes('allum')
            ? e.label.includes('aurait')
              ? '👁️'
              : '▶️'
            : e.label.includes('coupé') || e.label.includes('cession')
              ? '⏹️'
              : '🌙';
          return { ts: e.ts, emoji, text: `${e.label} — ${e.detail}` };
        }
        if (e.kind === 'heat_end') {
          const free = e.detail.includes('soleil');
          return { ts: e.ts, emoji: free ? '☀️' : '🔌', text: `Chauffé — ${e.detail}` };
        }
        if (e.kind === 'draw')
          return { ts: e.ts, emoji: '🚿', text: 'Eau chaude utilisée (douche / robinet)' };
        if (e.kind === 'appliance') {
          const emoji =
            e.label === 'Lave-vaisselle' ? '🍽️' : e.label === 'Lave-linge' ? '👕' : '🔌';
          return { ts: e.ts, emoji, text: `${e.label} — ${e.detail}` };
        }
        return { ts: e.ts, emoji: '✓', text: 'Ballon plein' };
      });
  });
  const visibleEvents = $derived(showAllEvents ? events : events.slice(0, EVENTS_FOLDED));
  const hiddenCount = $derived(Math.max(0, events.length - EVENTS_FOLDED));
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- ═══ Header ═══ -->
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2.5">
      <span class="led" class:blink={voyant === 'supplied'} style="--led: {voyantColor};"></span>
      <div class="min-w-0">
        <h3
          class="text-base leading-tight font-semibold tracking-tight"
          style="color: var(--color-fg);"
        >
          Eau chaude
        </h3>
        <div class="text-[12px] font-medium" style="color: {voyantColor};">{statusLine}</div>
      </div>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        onclick={() => (showPilot = !showPilot)}
        class="flex h-6 items-center justify-center rounded-full px-2.5 text-xs font-semibold"
        style="background: color-mix(in oklch, var(--color-primary) 16%, transparent); color: var(--color-primary);"
        aria-label="Détail du pilote"
        aria-expanded={showPilot}
      >
        pilote
      </button>
      <button
        type="button"
        onclick={() => (showHelp = !showHelp)}
        class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
        style="background: color-mix(in oklch, var(--color-muted-fg) 16%, transparent); color: var(--color-muted-fg);"
        aria-label="Comment ça marche"
        aria-expanded={showHelp}
      >
        ?
      </button>
    </div>
  </div>

  {#if anomalyLabel}
    <div class="cc-anomaly" role="alert">
      ⚠️ {anomalyLabel} — le pilotage automatique peut être affecté.
    </div>
  {/if}

  {#if pilot && pilot.apsAlert !== 'none'}
    <div class="cc-anomaly" role="alert">
      ⚠️ {pilot.apsAlert === 'unreachable'
        ? 'Panneaux APS injoignables (bridge muet)'
        : 'Panne probable des panneaux APS (les jumeaux SB1 produisent, pas l’APS)'} — la détection solaire
      est aveugle ; la recharge de nuit prend le relais.
    </div>
  {/if}

  {#if observation && mode === 'auto'}
    <div class="cc-observ">
      🧪 Observation : le pilote journalise ses décisions mais NE commande PAS le chauffe-eau — vous
      gardez la main pendant la validation.
    </div>
  {/if}

  <!-- ═══ 1. COUP D'ŒIL ═══ -->
  <div class="flex flex-col gap-2">
    <div class="flex items-baseline gap-2">
      <span class="text-[34px] leading-none font-bold" style="color: var(--color-fg);"
        >{showers != null ? `≈ ${showers}` : '—'}</span
      >
      <span class="text-sm" style="color: var(--color-muted-fg);">douches d'eau chaude</span>
    </div>
    <div
      class="h-2.5 overflow-hidden rounded-full"
      style="background: color-mix(in oklch, var(--color-muted-fg) 15%, transparent);"
    >
      <div
        class="h-full rounded-full"
        style="width: {fillPct}%; background: var(--color-success); transition: width 700ms var(--ease-out);"
      ></div>
    </div>
    <div class="text-sm font-medium" style="color: var(--color-fg);">{status.line}</div>
    {#if status.sub}
      <div class="text-[12.5px]" style="color: var(--color-muted-fg);">{status.sub}</div>
    {/if}
  </div>

  <!-- ═══ 2. AGIR ═══ -->
  <div class="flex flex-col gap-2">
    <div class="seg" role="radiogroup" aria-label="Mode de pilotage">
      <button
        type="button"
        class="seg-btn"
        class:seg-on={mode === 'auto'}
        onclick={() => setMode('auto')}>Auto</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-on={mode === 'manual'}
        onclick={() => setMode('manual')}>Manuel</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-on={mode === 'off'}
        onclick={() => setMode('off')}>Vacances</button
      >
    </div>

    {#if mode === 'manual'}
      <div class="flex items-center justify-between px-0.5">
        <span class="text-sm" style="color: var(--color-muted-fg);"
          >Allumer / éteindre vous-même</span
        >
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
      </div>
    {:else if mode === 'auto'}
      <button
        type="button"
        class="boost-btn"
        class:boost-on={cumulus.boostUntilFull}
        onclick={toggleBoost}
      >
        {cumulus.boostUntilFull
          ? '🔥 Chauffe forcée en cours — toucher pour annuler'
          : '🔥 Chauffer maintenant (jusqu’au plein)'}
      </button>
    {:else}
      <div class="px-0.5 text-[12.5px]" style="color: var(--color-muted-fg);">
        Le chauffe-eau reste éteint jusqu'au retour en Auto.
      </div>
    {/if}
  </div>

  <!-- ═══ 3. COMPRENDRE ═══ -->
  <div class="gain">
    <span class="gain-label">💶 Économies vs recharge de nuit</span>
    <span class="gain-vals tabular-nums">
      <strong style="color: {gainToday >= 0 ? 'var(--color-success)' : 'var(--color-warning)'};"
        >{fmtEur(gainToday)}</strong
      >
      <span class="gain-unit">auj.</span>
      <span class="gain-sep">·</span>
      <strong style="color: {gainWeek >= 0 ? 'var(--color-success)' : 'var(--color-warning)'};"
        >{fmtEur(gainWeek)}</strong
      >
      <span class="gain-unit">/ 7 j</span>
    </span>
  </div>

  <div class="ministats">
    <div class="ministat">
      <span class="ministat-label">Ballon</span>
      {#if cumulus.waterTempC !== null}
        <button
          type="button"
          class="temp-link"
          aria-label="Historique 4 h — eau chaude (ballon)"
          onclick={() => openTempHistory('thermo_cumulus', 'Eau chaude (ballon)')}
        >
          <strong class="ministat-value">{ballonTemp}</strong>
        </button>
      {:else}
        <strong class="ministat-value">{ballonTemp}</strong>
      {/if}
    </div>
    <div class="ministat">
      <span class="ministat-label">Dernier plein</span>
      <strong class="ministat-value">{lastFull}</strong>
    </div>
    <div class="ministat">
      <span class="ministat-label">Consommé auj.</span>
      <strong class="ministat-value">{consoToday}</strong>
    </div>
  </div>

  <!-- Journal du jour -->
  <div class="flex flex-col gap-2">
    <div
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Aujourd'hui
    </div>
    {#if events.length}
      {#each visibleEvents as e (e.ts + e.text)}
        <div class="flex items-center gap-2 text-sm">
          <span class="w-10 shrink-0 tabular-nums" style="color: var(--color-muted-fg);"
            >{hhmm(e.ts)}</span
          >
          <span class="shrink-0">{e.emoji}</span>
          <span class="min-w-0 flex-1 truncate" style="color: var(--color-fg);">{e.text}</span>
        </div>
      {/each}
      {#if hiddenCount > 0 || showAllEvents}
        <button
          type="button"
          class="fold-btn"
          onclick={() => (showAllEvents = !showAllEvents)}
          aria-expanded={showAllEvents}
        >
          {showAllEvents ? 'Réduire' : `Afficher les ${hiddenCount} autres`}
        </button>
      {/if}
    {:else}
      <div class="text-sm" style="color: var(--color-muted-fg);">
        Rien à signaler — la journée s'affichera ici (chauffes, douches…).
      </div>
    {/if}
  </div>

  <!-- ═══ Détail du PILOTE (spec : conditions, estimateur, compteurs, prochaine action) ═══ -->
  {#if showPilot && pilot}
    <div
      class="flex flex-col gap-2.5 rounded-xl p-3 text-sm"
      style="background: color-mix(in oklch, var(--color-primary) 8%, transparent);"
    >
      <div class="flex items-baseline justify-between gap-2">
        <p class="font-semibold" style="color: var(--color-fg);">
          {PILOT_PHASE_LABELS[pilot.phase] ?? pilot.phase}
        </p>
        <span class="text-xs" style="color: var(--color-muted-fg);"
          >depuis {fmtSince(pilot.phaseSinceTs)}</span
        >
      </div>
      <p class="text-[12.5px]" style="color: var(--color-muted-fg);">{pilot.note}</p>

      <!-- Les 7 conditions, VRAI/FAUX d'un coup d'œil -->
      <div class="conds">
        {#each pilot.conds as c (c.key)}
          <div class="cond" class:cond-ok={c.ok}>
            <span class="cond-dot">{c.ok ? '✓' : '✗'}</span>
            <span class="cond-label">{c.label}</span>
            <span class="cond-detail">{c.detail}</span>
          </div>
        {/each}
      </div>

      <!-- Déclencheur de SECOURS (bridage) : une voie d'allumage ALTERNATIVE, pas une
           8e condition — état neutre, jamais de ✗ rouge -->
      <div
        class="rescue"
        class:rescue-armed={pilot.rescue.state === 'armed'}
        class:rescue-unavailable={pilot.rescue.state === 'unavailable'}
      >
        <div class="rescue-head">
          <span class="rescue-title">Déclencheur de secours (bridage)</span>
          <span class="rescue-state">{pilot.rescue.detail}</span>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt style="color: var(--color-muted-fg);">Surplus invisible estimé</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">
            {pilot.invisibleSurplusW} W
          </dd>
          <dt style="color: var(--color-muted-fg);">Production APS (étalon)</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">{pilot.pApsW} W</dd>
          <dt style="color: var(--color-muted-fg);">Potentiel solaire total</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">
            {pilot.potTotalW} W
          </dd>
        </dl>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt style="color: var(--color-muted-fg);">Batteries</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {pilot.socNow !== null ? `${pilot.socNow} %` : '—'}
          {#if pilot.socStart !== null && pilot.socNow !== null}
            <span style="color: var(--color-muted-fg);">
              ({pilot.socNow - pilot.socStart >= 0 ? '+' : ''}{pilot.socNow - pilot.socStart} pts depuis
              l'allumage)</span
            >
          {/if}
        </dd>

        <dt style="color: var(--color-muted-fg);">Allumages aujourd'hui</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {pilot.solarStartsToday}/{pilot.quota} spontanés · {pilot.resumesToday} reprises
        </dd>

        <dt style="color: var(--color-muted-fg);">Prochaine action</dt>
        <dd class="text-right" style="color: var(--color-fg);">{pilot.nextAction}</dd>
      </dl>
    </div>
  {/if}

  <!-- Comment ça marche ? -->
  {#if showHelp}
    <div
      class="flex flex-col gap-2 rounded-xl p-3 text-sm"
      style="background: color-mix(in oklch, var(--color-muted-fg) 8%, transparent); color: var(--color-muted-fg);"
    >
      <p style="color: var(--color-fg);" class="font-semibold">La règle du pilote</p>
      <p>
        ⚡ Le chauffe-eau ne doit <strong>jamais</strong> être la cause d'un achat de courant à EDF. Il
        s'allume uniquement quand la maison donne de l'électricité au réseau (elle serait perdue) et s'éteint
        dès que la maison a besoin de sa puissance.
      </p>
      <p>
        ☀️ L'allumage exige sept conditions réunies pendant trois minutes (bouton « pilote » pour
        les voir). Les stations solaires mettent deux à trois minutes à réagir : ce court passage
        est le seul courant acheté — environ deux centimes par allumage.
      </p>
      <p>
        🌙 Si le soleil n'a pas suffi, une recharge de fin de nuit, aux heures creuses, garantit les
        douches du matin — calée pour finir vers sept heures et quart.
      </p>
      <p>
        💶 La ligne « Économies » compare ce qui a été payé à ce qu'aurait coûté une recharge de
        nuit systématique.
      </p>
      <p>✋ Vous gardez toujours la main : « Chauffer maintenant », « Manuel », « Vacances ».</p>
    </div>
  {/if}
</section>

<style>
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

  .cc-anomaly {
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-lg);
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.25;
    color: var(--color-fg);
    background: oklch(0.66 0.14 75 / 0.16);
    box-shadow: inset 0 0 0 1px oklch(0.66 0.14 75 / 0.5);
  }
  .cc-observ {
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-lg);
    font-size: 0.78rem;
    line-height: 1.3;
    color: var(--color-muted-fg);
    background: oklch(0.6 0.12 262 / 0.12);
    box-shadow: inset 0 0 0 1px oklch(0.6 0.12 262 / 0.35);
  }

  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .seg-btn {
    appearance: none;
    border: none;
    padding: 0.4rem 0;
    border-radius: 9999px;
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background 200ms ease,
      color 200ms ease;
  }
  .seg-on {
    background: var(--color-card);
    color: var(--color-fg);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.25);
  }

  .boost-btn {
    appearance: none;
    border: 1px solid var(--color-border);
    padding: 0.5rem 0.8rem;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background 200ms ease,
      border-color 200ms ease;
  }
  .boost-on {
    background: oklch(0.66 0.14 40 / 0.16);
    border-color: oklch(0.66 0.14 40 / 0.55);
  }

  .gain {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.45rem 0.7rem;
    border-radius: var(--radius-lg);
    background: color-mix(in oklch, var(--color-success) 10%, transparent);
  }
  .gain-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }
  .gain-vals {
    font-size: 12.5px;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }
  .gain-vals strong {
    font-size: 14px;
    font-weight: 700;
  }
  .gain-unit {
    font-size: 11.5px;
  }
  .gain-sep {
    margin: 0 0.25rem;
  }

  .ministats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    padding-top: 0.65rem;
    border-top: 1px solid var(--color-border);
  }
  .ministat {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .ministat-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }
  .ministat-value {
    font-size: 13.5px;
    font-weight: 650;
    color: var(--color-fg);
    white-space: nowrap;
  }
  .temp-link {
    appearance: none;
    border: none;
    background: none;
    margin: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
    -webkit-tap-highlight-color: transparent;
  }

  .fold-btn {
    appearance: none;
    border: none;
    background: transparent;
    align-self: flex-start;
    padding: 0.1rem 0;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-primary);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* ── Bloc « déclencheur de secours » : état NEUTRE (jamais rouge) ── */
  .rescue {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-lg);
    background: color-mix(in oklch, var(--color-muted-fg) 8%, transparent);
  }
  .rescue-armed {
    /* accent discret (cyan charte), PAS rouge : c'est une voie d'allumage prête */
    background: oklch(0.82 0.15 200 / 0.12);
    box-shadow: inset 0 0 0 1px oklch(0.82 0.15 200 / 0.35);
  }
  .rescue-unavailable {
    opacity: 0.75;
  }
  .rescue-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .rescue-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .rescue-state {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .rescue dl {
    font-size: 12px;
  }

  /* ── Grille des conditions du pilote (✓/✗ d'un coup d'œil) ── */
  .conds {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .cond {
    display: grid;
    grid-template-columns: 1.1rem auto 1fr;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 12.5px;
  }
  .cond-dot {
    font-weight: 700;
    color: var(--color-warning);
  }
  .cond-ok .cond-dot {
    color: var(--color-success);
  }
  .cond-label {
    font-weight: 600;
    color: var(--color-fg);
    white-space: nowrap;
  }
  .cond-detail {
    color: var(--color-muted-fg);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

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

  @media (prefers-reduced-motion: reduce) {
    .led.blink {
      animation: none;
    }
    .tg-knob {
      transition: none;
    }
  }
</style>
