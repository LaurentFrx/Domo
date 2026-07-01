<script lang="ts">
  /**
   * Carte « Eau chaude » — explique, en langage de tous les jours, ce que le
   * système ferait du chauffe-eau et pourquoi. Pensée pour être comprise sans
   * connaître le fonctionnement (réserve en douches, gratuit/soleil vs payant,
   * journal du jour en mots simples, « comment ça marche ? » dépliable).
   *
   * SHADOW : le système propose, il ne commande pas encore le relais.
   * Lecture seule ; stores connectés par la page (refcount).
   */
  import { cumulus } from '$stores/cumulus.svelte';
  import { em50 } from '$stores/em50.svelte';
  import { forecast } from '$stores/forecast.svelte';

  let showHelp = $state(false);
  let showEco = $state(false);

  const showersRaw = $derived(cumulus.showers);
  const showers = $derived(showersRaw != null ? Math.max(0, Math.round(showersRaw)) : null);
  const eAvail = $derived(cumulus.eAvailWh);
  const eFull = $derived(cumulus.eFullWh);
  const plan = $derived(cumulus.plan);
  const heatingNow = $derived(em50.cumulusPowerW > 500);

  // Barre « niveau d'eau chaude » (par rapport au plein).
  const fillPct = $derived(
    eAvail && eFull && eFull > 0 ? Math.min(100, Math.max(0, (eAvail / eFull) * 100)) : 0
  );

  // ── Phrase d'état (état réel + ce que le système déciderait) ──
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
          text: 'Le soleil produit : on rechargerait gratuitement, avec les panneaux.'
        };
      case 'wait_solar':
        return {
          emoji: '⏳',
          title: 'On attend le soleil',
          text: 'Il reste assez d’eau chaude ; on rechargera gratuitement dès que les panneaux produiront.'
        };
      case 'heat_hc':
        return {
          emoji: '🌙',
          title: 'Recharge prévue cette nuit',
          text: 'Peu de soleil attendu : on rechargera la nuit, quand l’électricité est moins chère.'
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

  // ── Journal du jour, en mots simples (on cache les détails techniques) ──
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
        (e) => e.ts >= start && (e.kind === 'heat_end' || e.kind === 'draw' || e.kind === 'full')
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
        return { ts: e.ts, emoji: '✓', text: 'Ballon plein' };
      });
  });
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- En-tête -->
  <div class="flex items-center justify-between">
    <h3 class="text-base font-semibold tracking-tight" style="color: var(--color-fg);">
      Eau chaude
    </h3>
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

  <!-- Détail économique (comprendre / valider la décision) -->
  {#if showEco && plan}
    <div
      class="flex flex-col gap-2 rounded-xl p-3 text-sm"
      style="background: color-mix(in oklch, var(--color-primary) 8%, transparent);"
    >
      <p class="font-semibold" style="color: var(--color-fg);">Le raisonnement, en détail</p>
      <p style="color: var(--color-muted-fg);">{plan.reason}</p>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt style="color: var(--color-muted-fg);">Réserve visée</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.showers} / {plan.floorShowers} douches
        </dd>

        <dt style="color: var(--color-muted-fg);">Manque pour le matin</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.deficitWh > 0 ? `${(plan.deficitWh / 1000).toFixed(1)} kWh` : 'rien ✓'}
        </dd>

        <dt style="color: var(--color-muted-fg);">Surplus solaire gratuit</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          {plan.surplusFreeW < 0
            ? 'non détecté'
            : `≈ ${plan.surplusFreeW} W · confiance ${plan.surplusConfidence}`}
        </dd>

        <dt style="color: var(--color-muted-fg);">Si on chauffe maintenant</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-fg);">
          appoint {plan.applianceW} W
        </dd>

        <dt style="color: var(--color-muted-fg);">Coût maintenant</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {plan.costNowEur <= plan.costHcEur
            ? 'var(--color-success)'
            : 'var(--color-fg)'};"
        >
          {plan.costNowEur.toFixed(3)} €/kWh
        </dd>

        <dt style="color: var(--color-muted-fg);">Coût en heures creuses</dt>
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
      </dl>
    </div>
  {/if}

  <!-- Mention « en test » -->
  <div class="text-xs" style="color: var(--color-muted-fg);">
    🧪 En test : le système propose la meilleure décision, mais c'est encore vous qui allumez le
    chauffe-eau.
  </div>

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
        >, qui produisent gratuitement. C'est le meilleur moment.
      </p>
      <p>
        🌙 S'il fait gris plusieurs jours, on recharge la nuit, quand l'électricité est moins chère.
      </p>
      <p>
        🧪 Pour l'instant le système ne fait que <strong>proposer</strong> le meilleur moment : on vérifie
        qu'il choisit bien avant de le laisser piloter tout seul.
      </p>
    </div>
  {/if}
</section>
