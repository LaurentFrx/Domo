<script lang="ts">
  /**
   * Carte « Eau chaude » — pilotage + visualisation du PILOTE V2 (règle zéro achat EDF).
   *
   * ÉCRITE POUR LA MAISON, PAS POUR L'INGÉNIEUR (refonte 23/08/2026).
   *
   * QUATRE REGARDS, ET RIEN D'AUTRE :
   *   1. combien il reste — « ≈ N douches » et sa jauge, RIEN d'autre ;
   *   2. ce que fait le chauffe-eau — UNE phrase, sans un seul watt ;
   *   3. le geste — « Chauffer maintenant », puis le choix du mode ;
   *   4. « Plus d'infos » — économies, chiffres du jour, journal, diagnostic.
   *
   * NI WATT NI DEGRÉ dans la vue de tous les jours (retour de Laurent, 23/08) :
   *   - « 896 / 2 000 W » ne veut rien dire pour qui veut juste de l'eau chaude —
   *     et le seuil lui-même est un artefact (le ballon tire 2 965 W, les 2 000 W
   *     ne sont que la part exigée du soleil, le reste venant des batteries) ;
   *   - aucune température affichée n'était CELLE DU ROBINET : la sonde lit le
   *     point bas (36 °C), le modèle calcule une moyenne (49 °C), et l'eau qui
   *     sort vient du HAUT, à la consigne du thermostat. Elle ne varie pas tant
   *     qu'il reste de la réserve, puis tiédit d'un coup — d'où le seul message
   *     utile : un avertissement quand la réserve tire à sa fin.
   * Watts et degrés restent disponibles sous « Plus d'infos », nommés.
   *
   * La faute de la première version était de tout traduire sans rien SUPPRIMER :
   * l'état se lisait sous le titre, puis en gros dans un encart, puis en légende
   * de jauge, puis dans les conditions. Chaque information ne doit vivre qu'à UN
   * endroit — c'est la seule règle qui rend la carte lisible.
   *
   * Deux pièges d'affichage corrigés au passage :
   *   - la température montrée est la MOYENNE du ballon, pas la sonde de point bas
   *     (structurellement ~12 °C plus froide : elle inquiétait pour rien) ;
   *   - les puisages consécutifs sont REGROUPÉS : un tick en détectait quatre
   *     bouts, la carte affichait « douche » quatre fois pour une seule.
   */
  import { cumulus, CUMULUS_ANOMALY_LABELS, PILOT_PHASE_LABELS } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { clock } from '$stores/clock.svelte';
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
  /** Puissance mesurée, gardée par le compteur : sans ce garde, un EM-50 mort
   *  pendant une chauffe laissait « En chauffe · 2,9 kW » à l'écran pendant des
   *  heures après l'arrêt réel du chauffe-eau. */
  const cumulusW = $derived(em50.available ? em50.cumulusPowerW : 0);
  const heatingNow = $derived(em50.available && cumulusW > HEATING_W);

  // ── Santé du PILOTE (distincte de celle du relais) ──
  // Le voyant ne regardait que le boîtier Shelly. Si l'orchestrateur meurt, le
  // relais reste joignable : voyant vert et « Alimenté · température atteinte »
  // pendant que la réserve, la jauge et la phase restent figées sur le dernier
  // tick. Deux pannes DISTINCTES, d'où deux indicateurs : la requête qui échoue
  // (orchestratorConnected) et le démon gelé (lastTickTs qui ne bouge plus).
  const TICK_STALE_MS = 300_000; // 5 min = 4 ticks manqués (cadence 65 s)
  const pilotOk = $derived(cumulus.orchestratorConnected);
  const tickAlive = $derived(
    cumulus.lastTickTs !== null && clock.now - cumulus.lastTickTs < TICK_STALE_MS
  );
  // `lastTickTs !== null` en garde : tant qu'aucun tick n'est jamais arrivé (SSR,
  // premier rendu), on ne sait pas encore — annoncer la panne à ce stade ferait
  // clignoter une alerte à chaque ouverture de l'app. Quand le pilote n'a JAMAIS
  // répondu, l'absence de chiffre (« — ») porte déjà le message.
  const pilotMuet = $derived(cumulus.lastTickTs !== null && (!pilotOk || !tickAlive));
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

  // ── Réserve d'eau chaude ──
  const showersRaw = $derived(cumulus.showers);
  const showers = $derived(showersRaw != null ? Math.max(0, Math.round(showersRaw)) : null);
  const eAvail = $derived(cumulus.eAvailWh);
  const eFull = $derived(cumulus.eFullWh);
  const fillPct = $derived(
    eAvail && eFull && eFull > 0 ? Math.min(100, Math.max(0, (eAvail / eFull) * 100)) : 0
  );
  /** Haut de l'eau dans la cuve SVG (zone utile y = 8 → 188). */
  const tankWaterY = $derived(8 + 180 * (1 - Math.min(100, Math.max(0, fillPct)) / 100));

  // ── Phase du pilote, en une ligne ──

  // ── Traduction des 7 conditions du pilote en français de tous les jours ──
  // Le serveur nomme les conditions pour un diagnostic ; la carte les nomme pour
  // quelqu'un qui veut juste savoir s'il aura de l'eau chaude.
  /**
   * Ce que fait le chauffe-eau — UNE phrase, jamais deux qui disent la même
   * chose. Première version : titre « En attente de soleil » + sous-titre « Le
   * soleil ne produit pas encore assez… » — le lecteur lisait deux fois le même
   * message. La cause EST l'état : « Chauffera dès qu'il y aura assez de soleil »
   * dit les deux d'un coup.
   */
  const COND_WAIT: Record<string, string> = {
    tank: 'Ballon plein — rien à faire',
    surplus: 'Chauffera dès qu’il y aura assez de soleil',
    battery: 'Les batteries se rechargent d’abord',
    quiet: 'Un gros appareil tourne — la chauffe attend qu’il ait fini',
    window: 'Chauffera quand il fera plus clair',
    quota: 'Assez d’essais pour aujourd’hui — ça reprend demain',
    delays: 'Le chauffe-eau se repose quelques minutes'
  };

  /** Libellés des 7 conditions dans le repli, pour qui va y regarder. */
  const COND_HUMAN: Record<string, string> = {
    tank: 'Place dans le ballon',
    surplus: 'Assez de soleil en trop',
    battery: 'Batteries assez chargées',
    quiet: 'Pas de gros appareil en marche',
    window: 'Il fait assez jour',
    quota: 'Essais restants aujourd’hui',
    delays: 'Chauffe-eau prêt à repartir'
  };

  const human = $derived.by((): { emoji: string; text: string } => {
    if (voyant === 'offline') return { emoji: '🔌', text: 'Le boîtier ne répond pas' };
    if (heatingNow) return { emoji: '🔥', text: 'L’eau chauffe en ce moment' };
    if (mode === 'off') return { emoji: '🌴', text: 'Mode vacances — chauffe-eau éteint' };
    if (mode === 'manual')
      return { emoji: '✋', text: relayOn ? 'Allumé à la main' : 'Éteint — à vous de l’allumer' };
    if (cumulus.boostUntilFull)
      return { emoji: '🔥', text: 'Chauffe demandée — dès que ce sera gratuit' };
    if (!pilot) return { emoji: '⏳', text: 'Démarrage en cours' };
    if (pilot.phase === 'plein') return { emoji: '✅', text: 'Ballon plein' };
    if (pilot.phase === 'recharge_hc')
      return { emoji: '🌙', text: 'Chauffe de nuit, au tarif le moins cher' };
    const ko = pilot.conds.find((c) => !c.ok);
    if (!ko) return { emoji: '👌', text: 'Prêt — la chauffe va démarrer' };
    return { emoji: '⏳', text: COND_WAIT[ko.key] ?? ko.detail };
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
  // La sonde est en POINT BAS : elle lit ~12 °C de moins que la moyenne du ballon
  // (stratification). Montrer 36 °C quand l'eau est à 48 °C fait croire à une
  // panne — on affiche la moyenne du modèle, la sonde reste dans les détails.
  const ballonTemp = $derived(
    cumulus.tankTempC !== null
      ? `${cumulus.tankTempC.toFixed(0)} °C`
      : cumulus.waterTempC !== null
        ? `${cumulus.waterTempC.toFixed(0)} °C`
        : '—'
  );
  const sondeTemp = $derived(
    cumulus.waterTempC !== null ? `${cumulus.waterTempC.toFixed(1)} °C` : '—'
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
  /**
   * Regroupe les puisages qui se suivent. Le moteur détecte la baisse de
   * température tick par tick : une seule douche produit 3 ou 4 événements
   * consécutifs (mesuré le 23/08 : 10:16, 10:17, 10:18, 10:19 pour 415 Wh au
   * total). Les afficher séparément fait croire à quatre douches.
   */
  const GROUP_GAP_MS = 12 * 60_000;
  const groupedEvents = $derived.by(() => {
    const out: { ts: number; emoji: string; text: string }[] = [];
    for (const e of events) {
      const prev = out[out.length - 1];
      const isDraw = e.emoji === '🚿';
      if (isDraw && prev?.emoji === '🚿' && prev.ts - e.ts <= GROUP_GAP_MS) {
        prev.ts = e.ts; // le groupe porte l'heure de DÉBUT du puisage
        prev.text = 'Eau chaude utilisée (douche / robinet)';
        continue;
      }
      out.push({ ...e });
    }
    return out;
  });
  const visibleEvents = $derived(
    showAllEvents ? groupedEvents : groupedEvents.slice(0, EVENTS_FOLDED)
  );
  const hiddenCount = $derived(Math.max(0, groupedEvents.length - EVENTS_FOLDED));
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
      </div>
    </div>
    <div class="flex items-center gap-1.5">
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

  {#if pilotMuet}
    <div class="cc-anomaly" role="alert">
      ⚠️ Le pilote de l'eau chaude ne répond plus — la réserve affichée n'est plus mise à jour. Le
      chauffe-eau continue sur son dernier réglage.
    </div>
  {/if}

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

  <!-- ═══ 1+2. LE BALLON — variante « Le ballon » adoptée par Laurent (23/08).
       L'eau chaude se VOIT : cuve remplie au niveau de la réserve, chaude en
       haut, froide en bas — fidèle à la stratification réelle. À droite, le
       chiffre qui compte et la phrase d'état. ═══ -->
  <div class="flex items-stretch gap-[18px]">
    <svg width="120" height="196" viewBox="0 0 120 196" class="shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id="planner-eau" x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0"
            style="stop-color: color-mix(in oklch, var(--color-hp) 90%, transparent);"
          />
          <stop
            offset="1"
            style="stop-color: color-mix(in oklch, var(--color-hc) 75%, transparent);"
          />
        </linearGradient>
        <clipPath id="planner-cuve"><rect x="8" y="8" width="104" height="180" rx="22" /></clipPath>
      </defs>
      <rect
        x="3"
        y="3"
        width="114"
        height="190"
        rx="26"
        style="fill: color-mix(in oklch, var(--color-muted) 50%, transparent); stroke: var(--color-border-strong);"
        stroke-width="2"
      />
      <g clip-path="url(#planner-cuve)">
        <rect
          x="8"
          y={tankWaterY}
          width="104"
          height={188 - tankWaterY}
          fill="url(#planner-eau)"
          style="transition: y 700ms var(--ease-out), height 700ms var(--ease-out);"
        />
        {#if fillPct > 4}
          <path
            d="M8 {tankWaterY} q13 -7 26 0 t26 0 t26 0 t26 0 v8 h-104 Z"
            style="fill: color-mix(in oklch, var(--color-hp) 45%, transparent);"
          />
        {/if}
      </g>
      <path
        d="M112 143 h5 M112 98 h5 M112 53 h5"
        style="stroke: var(--color-border-strong);"
        stroke-width="1.6"
      />
      <rect
        x="32"
        y="106"
        width="56"
        height="28"
        rx="14"
        style="fill: oklch(0.205 0.04 286 / 0.6);"
      />
      <text
        x="60"
        y="126"
        text-anchor="middle"
        font-size="20"
        font-weight="700"
        style="fill: oklch(0.985 0.01 286); font-family: inherit;"
        >{eFull && eAvail != null ? `${Math.round(fillPct)} %` : '—'}</text
      >
    </svg>
    <div class="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
      <div class="flex flex-col gap-0.5">
        <span class="text-[44px] leading-none font-bold" style="color: var(--color-fg);"
          >{!pilotMuet && showers != null ? `≈ ${showers}` : '—'}</span
        >
        <span class="text-sm" style="color: var(--color-muted-fg);">douches d'eau chaude</span>
      </div>
      <div class="flex items-start gap-2">
        <span class="shrink-0 text-lg leading-none" aria-hidden="true">{human.emoji}</span>
        <span class="min-w-0 text-[13.5px] leading-snug font-medium" style="color: var(--color-fg);"
          >{human.text}</span
        >
      </div>
    </div>
  </div>

  {#if !pilotMuet && showersRaw !== null && showersRaw < 1.2}
    <div class="cc-lowwater">
      🚿 Il ne reste presque plus d'eau chaude — la prochaine douche sera tiède.
    </div>
  {/if}

  <!-- ═══ 3. AGIR ═══ -->
  <div class="flex flex-col gap-2">
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
  </div>

  <!-- ═══ SECOND PLAN — un seul repli pour tout ce qui n'est pas « ai-je de l'eau
       chaude, et que fait le chauffe-eau ». Rien de ce qui suit n'a sa place dans
       la vue de tous les jours ; le premier écran doit tenir en quatre regards. ═══ -->
  <div class="flex items-center justify-between gap-3">
    <button
      type="button"
      class="fold-btn"
      onclick={() => (showPilot = !showPilot)}
      aria-expanded={showPilot}
    >
      {showPilot ? 'Masquer' : 'Plus d’infos'}
    </button>
    <span
      class="text-[12px] font-semibold tabular-nums"
      style="color: {gainWeek >= 0 ? 'var(--color-success)' : 'var(--color-warning)'};"
      >{fmtEur(gainWeek)} cette semaine</span
    >
  </div>

  {#if showPilot}
    <!-- Économies, chiffres du jour, journal -->
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
        <span class="ministat-label">Eau (moyenne)</span>
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

    {#if pilot}
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

        <!-- Les 7 conditions ne gouvernent QUE l'allumage. Les afficher pendant une
             chauffe en cours se lit comme une contradiction — « ✗ pas assez de
             soleil » sous « l'eau chauffe en ce moment », constaté le 23/08. Une
             fois le chauffe-eau lancé, ce sont les protections qui décident. -->
        {#if !heatingNow && !relayOn}
          <div class="conds">
            {#each pilot.conds as c (c.key)}
              <div class="cond" class:cond-ok={c.ok}>
                <span class="cond-dot">{c.ok ? '✓' : '✗'}</span>
                <span class="cond-label">{COND_HUMAN[c.key] ?? c.label}</span>
                <span class="cond-detail">{c.detail}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="text-[12.5px]" style="color: var(--color-muted-fg);">
            Les conditions d'allumage ne s'appliquent plus : le chauffe-eau est lancé, ce sont les
            protections (achat réseau, réserve batterie) qui décident maintenant.
          </div>
        {/if}

        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt style="color: var(--color-muted-fg);">Sonde (point bas du ballon)</dt>
          <dd class="text-right tabular-nums" style="color: var(--color-fg);">{sondeTemp}</dd>
        </dl>

        <!-- Horaires de la fenêtre solaire du jour (éphémérides) -->
        {#if pilot.sunWindowStart && pilot.sunWindowEnd}
          <div class="sun-window">
            <span>☀️ Fenêtre solaire aujourd'hui</span>
            <strong class="tabular-nums">{pilot.sunWindowStart} → {pilot.sunWindowEnd}</strong>
          </div>
          {#if pilot.sunWindowNote}
            <div class="sun-window-note">{pilot.sunWindowNote}</div>
          {/if}
        {/if}

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

          {#if cumulus.relaxAmplitudeC !== null && cumulus.relaxTauMin !== null}
            <dt style="color: var(--color-muted-fg);">Relaxation sonde (calibration)</dt>
            <dd class="text-right tabular-nums" style="color: var(--color-fg);">
              {cumulus.relaxAmplitudeC.toFixed(1)} °C · τ {Math.round(cumulus.relaxTauMin)} min
            </dd>
          {/if}
        </dl>
      </div>
    {/if}
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
        s'allume quand le soleil produit plus que ce que la maison consomme — surplus mesuré dans la charge
        de la batterie et au compteur — et s'éteint dès que la maison a besoin de sa puissance.
      </p>
      <p>
        ☀️ L'allumage exige sept conditions réunies pendant deux minutes (bouton « pilote » pour les
        voir), dont une réserve de batterie suffisante pour la nuit. La batterie se cale en quelques
        secondes : la minute et demie de transition est le seul courant acheté — environ un centime
        par allumage.
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

  /* Avertissement réserve basse — la seule information sur la température qui
     serve à quelque chose : l'eau du robinet ne tiédit qu'une fois le ballon vidé. */
  .cc-lowwater {
    border-radius: var(--radius-lg);
    padding: 9px 12px;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--color-hp);
    background: color-mix(in oklch, var(--color-hp) 12%, transparent);
    border: 1px solid color-mix(in oklch, var(--color-hp) 35%, transparent);
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

  /* ── Horaires de la fenêtre solaire du jour ── */
  .sun-window {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 12.5px;
    color: var(--color-muted-fg);
  }
  .sun-window strong {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .sun-window-note {
    margin-top: -0.2rem;
    font-size: 11px;
    color: var(--color-warning);
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
