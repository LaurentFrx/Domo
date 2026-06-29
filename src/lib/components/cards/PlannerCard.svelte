<script lang="ts">
  /**
   * Carte « Planificateur (observation) » — ÉTAPE 2a SHADOW.
   *
   * Montre la SIMULATION (ce que le planificateur prédictif décide) ⇄ le CONTRÔLE
   * (l'état réel). Le planificateur NE PILOTE RIEN : observation pure. Données
   * lues du store cumulus (plan, E_avail) + forecast (courbe PV du jour).
   *
   * Lecture seule ; les stores sont connectés par la page (refcount), pas ici.
   */
  import { cumulus } from '$stores/cumulus.svelte';
  import { forecast } from '$stores/forecast.svelte';
  import { smoothLinePath, smoothAreaPath, type XY } from '$utils/chart';

  const plan = $derived(cumulus.plan);
  const eAvail = $derived(cumulus.eAvailWh);
  const eFull = $derived(cumulus.eFullWh);
  const showers = $derived(cumulus.showers);
  const sonde = $derived(cumulus.waterTempC);
  const lastFull = $derived(cumulus.lastAnchorTs);

  // ── Libellé + couleur de l'action ──
  const ACTIONS = {
    heat_now: { label: 'Chauffe solaire', color: 'var(--color-solar)' },
    wait_solar: { label: 'Attend le pic solaire', color: 'var(--color-solar)' },
    heat_hc: { label: 'Chauffe heures creuses', color: 'var(--color-hc)' },
    wait: { label: 'En veille', color: 'var(--color-muted-fg)' }
  } as const;
  const act = $derived(plan ? ACTIONS[plan.action] : null);

  // heat_hc hors hiver = anormal (le solaire devrait suffire) → on le signale.
  const isWinter = $derived.by(() => {
    const m = new Date().getMonth(); // 0=janv
    return m <= 1 || m >= 10; // nov–fév
  });
  const hcAlert = $derived(plan?.action === 'heat_hc' && !isWinter);

  // ── Réserve (douches) : barre + marqueur plancher ──
  const fullShowers = $derived(
    eAvail && eAvail > 0 && showers ? (showers * (eFull ?? 0)) / eAvail : (showers ?? 0)
  );
  const floor = $derived(plan?.floorShowers ?? 3);
  const showerPct = $derived(
    fullShowers > 0 ? Math.min(100, ((showers ?? 0) / fullShowers) * 100) : 0
  );
  const floorPct = $derived(fullShowers > 0 ? Math.min(100, (floor / fullShowers) * 100) : 0);

  // ── Courbe PV du jour ──
  const W = 240;
  const H = 64;
  const PAD = 6;
  const pv = $derived.by(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return forecast.points.filter((p) => p.time.slice(0, 10) === today);
  });
  const maxKw = $derived(Math.max(1, ...pv.map((p) => p.kw)));
  const hourOf = (t: string) => Number(t.slice(11, 13)) + Number(t.slice(14, 16)) / 60;
  const xy = $derived.by((): XY[] =>
    pv.map((p) => ({ x: (hourOf(p.time) / 24) * W, y: H - PAD - (p.kw / maxKw) * (H - 2 * PAD) }))
  );
  const areaPath = $derived(smoothAreaPath(xy, H - PAD));
  const linePath = $derived(smoothLinePath(xy));
  const peak = $derived.by(() =>
    pv.reduce<(typeof pv)[number] | null>((m, p) => (!m || p.kw > m.kw ? p : m), null)
  );
  const peakPct = $derived(peak ? (hourOf(peak.time) / 24) * 100 : null);
  const nowPct = $derived.by(() => {
    const n = new Date();
    return ((n.getHours() + n.getMinutes() / 60) / 24) * 100;
  });
  const targetPct = $derived(plan?.targetHour != null ? (plan.targetHour / 24) * 100 : null);

  const hhmm = (ts: number | null) =>
    ts ? new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const kwh = (wh: number | null) => (wh == null ? '—' : (wh / 1000).toFixed(1));

  // ── Timeline du jour (transitions de plan, chauffes, puisages, pleins) ──
  const KIND: Record<string, { icon: string; color: string }> = {
    plan: { icon: '◈', color: 'var(--color-primary)' },
    heat_start: { icon: '▶', color: 'var(--color-hp)' },
    heat_end: { icon: '■', color: 'var(--color-muted-fg)' },
    draw: { icon: '↓', color: 'var(--color-hc)' },
    full: { icon: '✓', color: 'var(--color-success)' }
  };
  const planLabel = (a: string) => (a in ACTIONS ? ACTIONS[a as keyof typeof ACTIONS].label : a);
  const events = $derived.by(() => {
    const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return cumulus.shadowLog
      .filter((e) => e.ts >= start)
      .slice()
      .reverse();
  });
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- En-tête -->
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-semibold tracking-tight" style="color: var(--color-fg);">
      Planificateur
    </h3>
    <span
      class="rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
      style="background: color-mix(in oklch, var(--color-muted-fg) 18%, transparent); color: var(--color-muted-fg);"
    >
      observation · ne pilote pas
    </span>
  </div>

  <!-- Action courante -->
  <div class="flex items-baseline gap-2">
    <span
      class="h-2.5 w-2.5 shrink-0 rounded-full"
      style="background: {act?.color ?? 'var(--color-muted-fg)'};"
    ></span>
    <div class="min-w-0">
      <div class="text-lg leading-tight font-semibold" style="color: var(--color-fg);">
        {act?.label ?? '—'}
        {#if plan?.targetHour != null}
          <span class="text-sm font-normal" style="color: var(--color-muted-fg);"
            >· cible {plan.targetHour}h</span
          >
        {/if}
      </div>
      <div class="truncate text-xs" style="color: var(--color-muted-fg);">
        {plan?.reason ?? 'en attente du moteur…'}
      </div>
    </div>
  </div>

  <!-- Réserve (douches) -->
  <div class="flex flex-col gap-1">
    <div class="flex justify-between text-xs" style="color: var(--color-muted-fg);">
      <span>Réserve</span>
      <span
        ><strong style="color: var(--color-fg);"
          >{showers != null ? showers.toFixed(1) : '—'}</strong
        >
        / plancher {floor} douches</span
      >
    </div>
    <div
      class="relative h-2 overflow-hidden rounded-full"
      style="background: color-mix(in oklch, var(--color-muted-fg) 15%, transparent);"
    >
      <div
        class="h-full rounded-full"
        style="width: {showerPct}%; background: var(--color-success);"
      ></div>
      <!-- marqueur plancher -->
      <div
        class="absolute top-0 h-full w-0.5"
        style="left: {floorPct}%; background: var(--color-hp);"
      ></div>
    </div>
  </div>

  <!-- Courbe PV du jour -->
  <div class="flex flex-col gap-1">
    <div class="flex justify-between text-xs" style="color: var(--color-muted-fg);">
      <span>Prévision PV — aujourd'hui</span>
      {#if peak}<span>pic {peak.kw.toFixed(1)} kW à {peak.time.slice(11, 13)}h</span>{/if}
    </div>
    <div class="relative h-16 w-full overflow-hidden">
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="absolute inset-0 h-full w-full">
        {#if areaPath}
          <path d={areaPath} fill="color-mix(in oklch, var(--color-solar) 22%, transparent)" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-solar)"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
        {/if}
        <!-- maintenant -->
        <line
          x1={(nowPct / 100) * W}
          y1="0"
          x2={(nowPct / 100) * W}
          y2={H}
          stroke="var(--color-fg)"
          stroke-width="1"
          stroke-dasharray="2 2"
          vector-effect="non-scaling-stroke"
          opacity="0.5"
        />
        {#if targetPct != null}
          <line
            x1={(targetPct / 100) * W}
            y1="0"
            x2={(targetPct / 100) * W}
            y2={H}
            stroke="var(--color-primary)"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      </svg>
      {#if peakPct != null}
        <div
          class="absolute -translate-x-1/2 text-[10px] font-medium"
          style="left: {peakPct}%; top: 0; color: var(--color-solar);"
        >
          ▾
        </div>
      {/if}
    </div>
  </div>

  <!-- État réel + concordance -->
  <div class="grid grid-cols-3 gap-2 text-center">
    <div
      class="rounded-lg p-2"
      style="background: color-mix(in oklch, var(--color-muted-fg) 10%, transparent);"
    >
      <div class="text-sm font-semibold" style="color: var(--color-fg);">
        {kwh(eAvail)}/{kwh(eFull)}
      </div>
      <div class="text-[10px]" style="color: var(--color-muted-fg);">kWh dispo</div>
    </div>
    <div
      class="rounded-lg p-2"
      style="background: color-mix(in oklch, var(--color-muted-fg) 10%, transparent);"
    >
      <div class="text-sm font-semibold" style="color: var(--color-fg);">
        {sonde != null ? Math.round(sonde) + '°' : '—'}
      </div>
      <div class="text-[10px]" style="color: var(--color-muted-fg);">sonde eau</div>
    </div>
    <div
      class="rounded-lg p-2"
      style="background: color-mix(in oklch, var(--color-muted-fg) 10%, transparent);"
    >
      <div class="text-sm font-semibold" style="color: var(--color-fg);">{hhmm(lastFull)}</div>
      <div class="text-[10px]" style="color: var(--color-muted-fg);">dernier plein</div>
    </div>
  </div>

  <!-- Timeline du jour (simulation ⇄ contrôle) -->
  {#if events.length}
    <div class="flex flex-col gap-1">
      <div class="text-xs" style="color: var(--color-muted-fg);">Aujourd'hui</div>
      <div class="flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-1">
        {#each events as e (e.ts + '-' + e.kind)}
          <div class="flex items-start gap-2 text-xs">
            <span class="shrink-0 tabular-nums" style="color: var(--color-muted-fg);"
              >{hhmm(e.ts)}</span
            >
            <span class="shrink-0" style="color: {KIND[e.kind]?.color ?? 'var(--color-muted-fg)'};"
              >{KIND[e.kind]?.icon ?? '·'}</span
            >
            <span class="min-w-0 flex-1" style="color: var(--color-fg);">
              {e.kind === 'plan' ? planLabel(e.label) : e.label}{#if e.detail}<span
                  style="color: var(--color-muted-fg);"
                >
                  · {e.detail}</span
                >{/if}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if hcAlert}
    <div
      class="rounded-lg px-3 py-2 text-xs"
      style="background: color-mix(in oklch, var(--color-hp) 18%, transparent); color: var(--color-hp);"
    >
      ⚠️ Chauffe payée recommandée hors hiver — le solaire devrait suffire. À vérifier (réglage
      réserve / pic PV).
    </div>
  {/if}
</section>
