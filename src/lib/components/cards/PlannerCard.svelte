<script lang="ts">
  /**
   * Carte « Eau chaude » — LA carte unique du chauffe-eau : pilotage + visualisation.
   * (Fusion des ex-cartes « Chauffe-eau » (contrôles) et « Eau chaude » (plan/journal).)
   *
   * En langage de tous les jours (compréhensible sans connaître le système) :
   *   - voyant d'état réel (chauffe / alimenté / éteint) calé sur la puissance EM-50 ;
   *   - réserve « ≈ N douches » + jauge ;
   *   - phrase d'état du pilote automatique + prochaine chauffe prévue ;
   *   - pilotage : Auto / Manuel / Vacances, marche-arrêt manuel, « Chauffer maintenant » ;
   *   - économies (boucle de regret) : gain € du jour et des 7 derniers jours vs tout-HC ;
   *   - journal du jour (chauffes, douches, gros appareils, plein) ;
   *   - détail économique dépliable (le raisonnement chiffré du pilote).
   *
   * Lecture via stores connectés par la page (refcount) ; commandes = méthodes store.
   */
  import { cumulus, CUMULUS_ANOMALY_LABELS } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { haptic } from '$utils/haptic';
  import { openTempHistory } from '$stores/temp-history.svelte';

  let showHelp = $state(false);
  let showEco = $state(false);

  const HEATING_W = 500; // au-dessus → le cumulus chauffe (EM-50 voie cumulus)

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

  // ── Phrase d'état (état réel + décision du pilote) ──
  const status = $derived.by(() => {
    if (heatingNow)
      return {
        emoji: '🔥',
        title: 'Le chauffe-eau chauffe en ce moment',
        text: "Il refait le plein d'eau chaude."
      };
    switch (plan?.action) {
      case 'heat_now':
        return {
          emoji: '☀️',
          title: 'C’est le bon moment pour chauffer',
          text: 'Le soleil produit : recharge gratuite avec les panneaux.'
        };
      case 'wait_solar':
        return {
          emoji: '⏳',
          title: 'On attend le soleil',
          text: 'Il reste assez d’eau chaude ; la recharge gratuite viendra avec les panneaux.'
        };
      case 'heat_hc':
        return {
          emoji: '🌙',
          title: 'Recharge de nuit en cours de préparation',
          text: 'Peu de soleil attendu : recharge la nuit, quand l’électricité est moins chère.'
        };
      default:
        return {
          emoji: '😴',
          title: 'Le chauffe-eau se repose',
          text: 'Il reste assez d’eau chaude. Rien à faire pour l’instant.'
        };
    }
  });

  // ── Prochaine chauffe prévue (en clair) ──
  const nextSolar = $derived.by(() => {
    const now = Date.now();
    const chrono = forecast.points
      .map((p) => ({ d: new Date(p.time), kw: p.kw }))
      .filter((x) => x.d.getTime() > now && x.kw >= 1.5)
      .sort((a, b) => a.d.getTime() - b.d.getTime());
    if (!chrono.length) return null;
    const f = chrono[0];
    const sameDay = f.d.getDate() === new Date().getDate();
    return `${sameDay ? 'aujourd’hui' : 'demain'} vers ${f.d.getHours()} h`;
  });
  const nextHeat = $derived.by(() => {
    if (heatingNow) return null;
    if (plan?.action === 'heat_hc')
      return { emoji: '🌙', text: 'cette nuit (électricité moins chère)' };
    if (plan?.targetHour != null)
      return { emoji: '☀️', text: `aujourd’hui vers ${plan.targetHour} h — gratuit, au soleil` };
    if (nextSolar) return { emoji: '☀️', text: `${nextSolar} — gratuit, au soleil` };
    return null;
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
  const fmtEur = (v: number) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(2).replace('.', ',')} €`;

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

  // ── Journal du jour, en mots simples ──
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
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- En-tête : voyant + titre/statut + boutons détail/aide -->
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
      >
        détail
      </button>
      <button
        type="button"
        onclick={() => (showHelp = !showHelp)}
        class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
        style="background: color-mix(in oklch, var(--color-muted-fg) 16%, transparent); color: var(--color-muted-fg);"
        aria-label="Comment ça marche"
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

  <!-- Réserve d'eau chaude -->
  <div class="flex flex-col gap-1.5">
    <div class="flex items-baseline gap-2">
      <span class="text-2xl font-bold" style="color: var(--color-fg);"
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
        style="width: {fillPct}%; background: var(--color-success);"
      ></div>
    </div>
  </div>

  <!-- État + raison, en clair -->
  <div class="flex gap-3">
    <span class="text-2xl leading-none">{status.emoji}</span>
    <div class="min-w-0">
      <div class="font-semibold" style="color: var(--color-fg);">{status.title}</div>
      <div class="text-sm" style="color: var(--color-muted-fg);">{status.text}</div>
      {#if nextHeat}
        <div class="mt-1 text-sm" style="color: var(--color-fg);">
          {nextHeat.emoji} Prochaine chauffe : {nextHeat.text}
        </div>
      {/if}
    </div>
  </div>

  <!-- Pilotage -->
  <div class="flex flex-col gap-2.5">
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
      <div class="flex items-center justify-between">
        <span class="text-sm" style="color: var(--color-muted-fg);">Chauffe-eau</span>
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
      <div class="text-xs" style="color: var(--color-muted-fg);">
        Mode vacances : le chauffe-eau reste éteint jusqu'au retour en Auto.
      </div>
    {/if}
  </div>

  <!-- Économies (boucle de regret) -->
  <div class="gain">
    <span class="gain-label">💶 Économisé vs « tout recharger la nuit »</span>
    <span class="gain-vals">
      <strong style="color: {gainToday >= 0 ? 'var(--color-success)' : 'var(--color-warning)'};"
        >{fmtEur(gainToday)}</strong
      >
      <span> aujourd'hui</span>
      <span class="gain-sep">·</span>
      <strong style="color: {gainWeek >= 0 ? 'var(--color-success)' : 'var(--color-warning)'};"
        >{fmtEur(gainWeek)}</strong
      >
      <span> / 7 j</span>
    </span>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat">
      <span>Température du ballon</span>
      {#if cumulus.waterTempC !== null}
        <button
          type="button"
          class="temp-link"
          aria-label="Historique 4 h — eau chaude (ballon)"
          onclick={() => openTempHistory('thermo_cumulus', 'Eau chaude (ballon)')}
        >
          <strong>{ballonTemp}</strong>
        </button>
      {:else}
        <strong>{ballonTemp}</strong>
      {/if}
    </div>
    <div class="stat"><span>Dernier plein</span><strong>{lastFull}</strong></div>
    <div class="stat"><span>Consommé aujourd'hui</span><strong>{consoToday}</strong></div>
  </div>

  <!-- Journal du jour -->
  {#if events.length}
    <div class="flex flex-col gap-2">
      <div
        class="text-xs font-medium tracking-wide uppercase"
        style="color: var(--color-muted-fg);"
      >
        Aujourd'hui
      </div>
      {#each events as e (e.ts + e.text)}
        <div class="flex items-center gap-2 text-sm">
          <span class="w-10 shrink-0 tabular-nums" style="color: var(--color-muted-fg);"
            >{hhmm(e.ts)}</span
          >
          <span class="shrink-0">{e.emoji}</span>
          <span class="min-w-0 flex-1" style="color: var(--color-fg);">{e.text}</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="text-sm" style="color: var(--color-muted-fg);">
      Rien à signaler aujourd'hui — la journée s'affichera ici (chauffes, douches…).
    </div>
  {/if}

  <!-- Détail économique (comprendre / vérifier la décision du pilote) -->
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

  <!-- Statut du pilotage -->
  {#if mode === 'auto'}
    <div class="text-xs" style="color: var(--color-muted-fg);">
      🤖 Pilotage automatique actif — le système allume et éteint le chauffe-eau au meilleur moment.
    </div>
  {:else}
    <div class="text-xs" style="color: var(--color-muted-fg);">
      ✋ Pilotage {mode === 'off' ? 'coupé (vacances)' : 'manuel'} — repassez en Auto pour laisser le
      système optimiser.
    </div>
  {/if}

  <!-- Comment ça marche ? (dépliable) -->
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
        🚿 Quand on tire de l'eau chaude, la réserve baisse. Quand elle est basse, il faut
        réchauffer.
      </p>
      <p>
        ☀️ Réchauffer coûte de l'électricité — sauf en pleine journée avec vos <strong
          >panneaux solaires</strong
        >, qui produisent gratuitement. C'est le meilleur moment, et le système le choisit tout
        seul.
      </p>
      <p>
        🌙 S'il fait gris plusieurs jours, il recharge la nuit, quand l'électricité est moins chère
        — juste à temps pour les douches du matin.
      </p>
      <p>
        💶 La ligne « Économisé » compare chaque jour ce qui a été payé à ce qu'aurait coûté une
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
    padding: 0.55rem 0.8rem;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--color-fg);
    font-size: 13.5px;
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

  /* ── Ligne économies ── */
  .gain {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-lg);
    background: color-mix(in oklch, var(--color-success) 10%, transparent);
  }
  .gain-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }
  .gain-vals {
    font-size: 13px;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }
  .gain-vals strong {
    font-size: 14px;
    font-weight: 700;
  }
  .gain-sep {
    margin: 0 0.3rem;
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
  .temp-link {
    appearance: none;
    border: none;
    background: none;
    margin: 0;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
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
