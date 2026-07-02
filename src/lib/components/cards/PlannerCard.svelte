<script lang="ts">
  /**
   * Carte « Eau chaude » — LA carte unique du chauffe-eau : pilotage + visualisation.
   *
   * Ergonomie en 3 niveaux de lecture (refonte 2026-07-02, « c'était fouillis ») :
   *   1. COUP D'ŒIL  — héros : « ≈ N douches » + jauge + UNE ligne d'état (l'intention
   *      du pilote + prochaine chauffe fusionnées — plus de pavé redondant) ;
   *   2. AGIR        — segmented Auto/Manuel/Vacances + contrôle contextuel
   *      (interrupteur en manuel, « Chauffer maintenant » en auto) ;
   *   3. COMPRENDRE  — économies (1 ligne), mini-stats horizontales (signature Yeldra :
   *      libellés uppercase + valeurs fortes), journal du jour PLIÉ à 4 événements,
   *      détail économique et aide dépliables.
   *
   * Zéro jargon (lisible par toute la famille) ; l'état machine (LED + statut coloré)
   * vit dans le header, l'intention du pilote dans le héros — dits UNE seule fois.
   */
  import { cumulus, CUMULUS_ANOMALY_LABELS } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { haptic } from '$utils/haptic';
  import { openTempHistory } from '$stores/temp-history.svelte';

  let showHelp = $state(false);
  let showEco = $state(false);
  let showAllEvents = $state(false);

  const HEATING_W = 500; // au-dessus → le cumulus chauffe (EM-50 voie cumulus)
  const EVENTS_FOLDED = 4; // journal plié : les N plus récents

  const online = $derived(cumulus.relayConnected);
  const relayOn = $derived(cumulus.relayOn === true);
  const anomalyLabel = $derived(CUMULUS_ANOMALY_LABELS[cumulus.anomaly] || '');
  const cumulusW = $derived(em50.cumulusPowerW);
  const heatingNow = $derived(cumulusW > HEATING_W);

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
  const plan = $derived(cumulus.plan);
  const fillPct = $derived(
    eAvail && eFull && eFull > 0 ? Math.min(100, Math.max(0, (eAvail / eFull) * 100)) : 0
  );

  // ── L'état du pilote, en UNE ligne (+ sous-ligne éventuelle) ──
  const solarAhead = $derived.by(() => {
    const now = Date.now();
    return forecast.points.some((p) => new Date(p.time).getTime() > now && p.kw >= 1.5);
  });
  const status = $derived.by((): { line: string; sub: string | null } => {
    if (heatingNow) {
      const free = plan?.measured && plan.autoconsoPct >= 80;
      return {
        line: `🔥 Refait le plein d'eau chaude${free ? ' — gratuit, au soleil' : ''}`,
        sub: null
      };
    }
    switch (plan?.action) {
      case 'heat_now':
        return { line: '☀️ Chauffe imminente — surplus solaire disponible', sub: null };
      case 'wait_solar':
        return {
          line: '⏳ On attend le soleil pour recharger gratuitement',
          sub: plan.targetHour != null ? `Prochaine chauffe : vers ${plan.targetHour} h` : null
        };
      case 'heat_hc':
        return {
          line: '🌙 Recharge prévue cette nuit (électricité moins chère)',
          sub: null
        };
      default:
        return {
          line: '😴 Se repose — il reste assez d’eau chaude',
          sub: solarAhead
            ? 'Prochaine chauffe : dès que les batteries seront pleines — gratuit'
            : null
        };
    }
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

  // ── Économies (boucle de regret) : gain vs « tout recharger la nuit » ──
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

  // ── Journal du jour, en mots simples (plié à EVENTS_FOLDED) ──
  const hhmm = (ts: number) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  // Heure fractionnaire (7.1) → « 7 h 06 »
  const fmtHour = (h: number) => {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${hh} h${mm ? ' ' + String(mm).padStart(2, '0') : ''}`;
  };
  const events = $derived.by(() => {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return cumulus.shadowLog
      .filter(
        (e) =>
          e.ts >= start &&
          (e.kind === 'heat_end' ||
            e.kind === 'draw' ||
            e.kind === 'full' ||
            e.kind === 'appliance')
      )
      .slice()
      .reverse()
      .map((e) => {
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
  <!-- ═══ Header : état machine (LED + statut) + actions ═══ -->
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
        onclick={() => (showEco = !showEco)}
        class="flex h-6 items-center justify-center rounded-full px-2.5 text-xs font-semibold"
        style="background: color-mix(in oklch, var(--color-primary) 16%, transparent); color: var(--color-primary);"
        aria-label="Détail de la décision"
        aria-expanded={showEco}
      >
        détail
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

  <!-- Anomalie : la carte ne ment pas si le moteur a perdu le contrôle -->
  {#if anomalyLabel}
    <div class="cc-anomaly" role="alert">
      ⚠️ {anomalyLabel} — le pilotage automatique peut être affecté.
    </div>
  {/if}

  <!-- ═══ 1. COUP D'ŒIL : réserve + intention du pilote ═══ -->
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

  <!-- ═══ 2. AGIR : mode + contrôle contextuel ═══ -->
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
  <!-- Économies (boucle de regret) — 1 ligne -->
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

  <!-- Mini-stats horizontales (libellés uppercase + valeurs fortes) -->
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

  <!-- Journal du jour (plié à 4) -->
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

  <!-- Détail économique (dépliable via « détail ») -->
  {#if showEco && plan}
    <div
      class="flex flex-col gap-2 rounded-xl p-3 text-sm"
      style="background: color-mix(in oklch, var(--color-primary) 8%, transparent);"
    >
      <p class="font-semibold" style="color: var(--color-fg);">Le raisonnement, en détail</p>
      <p style="color: var(--color-muted-fg);">{plan.reason}</p>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt style="color: var(--color-muted-fg);">Réseau EDF (mesuré)</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.gridNowW <= 0
            ? 'var(--color-success)'
            : plan.gridNowW <= 300
              ? 'var(--color-fg)'
              : 'var(--color-warning)'};"
        >
          {plan.gridNowW <= 0 ? `${-plan.gridNowW} W injectés` : `${plan.gridNowW} W soutirés`}
        </dd>

        <dt style="color: var(--color-muted-fg);">Réserve visée</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.showers} / {plan.floorShowers} douches
        </dd>

        <dt style="color: var(--color-muted-fg);">Manque pour le matin</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.deficitWh > 0 ? `${(plan.deficitWh / 1000).toFixed(1)} kWh` : 'rien ✓'}
        </dd>

        <dt style="color: var(--color-muted-fg);">
          {plan.measured ? 'Chauffe en cours : autoconso' : 'Si on chauffe : autoconso (est.)'}
        </dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.autoconsoPct >= 90
            ? 'var(--color-success)'
            : plan.autoconsoPct >= 60
              ? 'var(--color-fg)'
              : 'var(--color-warning)'};"
        >
          {plan.autoconsoPct} %
        </dd>

        <dt style="color: var(--color-muted-fg);">· dont solaire (gratuit)</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">{plan.pvCoverW} W</dd>

        <dt style="color: var(--color-muted-fg);">· dont batterie</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.batteryCoverW} W
        </dd>

        <dt style="color: var(--color-muted-fg);">· dont réseau EDF</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.gridDrawW <= 300 ? 'var(--color-success)' : 'var(--color-warning)'};"
        >
          {plan.gridDrawW} W
        </dd>

        <dt style="color: var(--color-muted-fg);">Réserve batterie du soir</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {(plan.eveningNeedWh / 1000).toFixed(1)} kWh à garder
        </dd>

        <dt style="color: var(--color-muted-fg);">Pertes d'ici le matin</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {(plan.storageLossWh / 1000).toFixed(1)} kWh
        </dd>

        <dt style="color: var(--color-muted-fg);">Coût du kWh utile — maintenant</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.costNowEur <= plan.costHcEur
            ? 'var(--color-success)'
            : 'var(--color-fg)'};"
        >
          {plan.costNowEur.toFixed(3)} €/kWh
        </dd>

        <dt style="color: var(--color-muted-fg);">Coût du kWh utile — heures creuses</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.costHcEur < plan.costNowEur
            ? 'var(--color-success)'
            : 'var(--color-fg)'};"
        >
          {plan.costHcEur.toFixed(3)} €/kWh
        </dd>

        {#if plan.backstopHcHour != null}
          <dt style="color: var(--color-muted-fg);">Filet nuit (au plus tard)</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">
            {fmtHour(plan.backstopHcHour)}
          </dd>
        {/if}

        {#if cumulus.regretDay && cumulus.regretDay.injWh > 0}
          <dt style="color: var(--color-muted-fg);">Chauffé aujourd'hui</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">
            ☀️ {(cumulus.regretDay.pvWh / 1000).toFixed(1)} · 🔋 {(
              cumulus.regretDay.battWh / 1000
            ).toFixed(1)} · ⚡ {(
              (cumulus.regretDay.gridHpWh + cumulus.regretDay.gridHcWh) /
              1000
            ).toFixed(1)} kWh
          </dd>
        {/if}
      </dl>
    </div>
  {/if}

  <!-- Comment ça marche ? (dépliable via « ? ») -->
  {#if showHelp}
    <div
      class="flex flex-col gap-2 rounded-xl p-3 text-sm"
      style="background: color-mix(in oklch, var(--color-muted-fg) 8%, transparent); color: var(--color-muted-fg);"
    >
      <p style="color: var(--color-fg);" class="font-semibold">Comment marche votre eau chaude</p>
      <p>
        🛢️ Un grand réservoir (300 L) garde de l'eau chaude d'avance — de quoi prendre plusieurs
        douches sans rien faire.
      </p>
      <p>
        ☀️ Réchauffer coûte de l'électricité — sauf quand vos <strong>panneaux solaires</strong>
        produisent plus que la maison ne consomme. Le système choisit ce moment tout seul.
      </p>
      <p>
        🌙 S'il fait gris plusieurs jours, il recharge la nuit, quand l'électricité est moins chère
        — juste à temps pour les douches du matin.
      </p>
      <p>
        💶 La ligne « Économies » compare chaque jour ce qui a été payé à ce qu'aurait coûté une
        recharge de nuit systématique : c'est le gain réel du pilotage.
      </p>
      <p>
        ✋ Vous gardez toujours la main : « Chauffer maintenant » force une chauffe immédiate, «
        Manuel » vous rend l'interrupteur, « Vacances » coupe tout.
      </p>
    </div>
  {/if}
</section>

<style>
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

  /* ── Bandeau d'anomalie (ambre calme, oklch direct — safe Chrome) ── */
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

  /* ── Sélecteur de mode (segmented) ── */
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

  /* ── Bouton « Chauffer maintenant » ── */
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

  /* ── Ligne économies (compacte) ── */
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

  /* ── Mini-stats horizontales (signature Yeldra : label uppercase + valeur forte) ── */
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

  /* ── Bouton plier/déplier le journal ── */
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

  /* ── Interrupteur marche/arrêt (manuel) ── */
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
