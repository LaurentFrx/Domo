<script lang="ts">
  /**
   * LABO — validation du critère énergie du chauffe-eau, en service depuis le
   * 23/08 (docs/cumulus-reserve-dynamique.md). La page répond à UNE question :
   * peut-on retirer les vieux seuils (Max AC 65 %, surplus 2 000 W, surplus
   * invisible) ? Elle montre, tick par tick : le bilan du critère (le parc
   * face au besoin), ce que chaque famille de voies aurait décidé, et ce qui
   * s'est réellement passé — dont l'achat EDF pendant les chauffes, le seul
   * juge de paix. A remplacé le shadow de désirabilité (NO-GO, supprimé).
   */
  import { onMount, onDestroy } from 'svelte';
  import { cumulusLabo, type CriterionSample } from '$lib/stores/cumulusLabo.svelte';
  onMount(() => cumulusLabo.connect());
  onDestroy(() => cumulusLabo.disconnect());

  const cur = $derived(cumulusLabo.current);
  const samples = $derived(cumulusLabo.samples);

  const fmtTime = (ts: number): string =>
    new Date(ts).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris'
    });
  const kWh = (wh: number | null): string => (wh === null ? '—' : `${(wh / 1000).toFixed(2)} kWh`);

  // ── Verdict courant ──
  const manqueWh = $derived(
    cur && cur.uParcWh !== null && cur.besoinWh !== null
      ? Math.max(0, cur.besoinWh - cur.uParcWh)
      : null
  );
  const tamponWh = $derived(
    cur && cur.besoinWh !== null && cur.eChauffeWh !== null && cur.reserveWh !== null
      ? cur.besoinWh - cur.eChauffeWh - cur.reserveWh
      : null
  );

  // ── Barre besoin (segments chauffe / soirée / tampon) + repère parc ──
  // Échelle commune = max(besoin, parc) pour que le repère reste dans la barre.
  const barScale = $derived(
    cur && cur.besoinWh !== null ? Math.max(cur.besoinWh, cur.uParcWh ?? 0) : null
  );
  const segPct = (wh: number | null): number =>
    barScale && wh !== null ? (wh / barScale) * 100 : 0;

  // ── Courbe parc vs besoin sur la fenêtre chargée (~12 h) ──
  const CHART_W = 600;
  const CHART_H = 130;
  const chart = $derived.by(() => {
    const pts = samples.filter((s) => s.uParcWh !== null && s.besoinWh !== null);
    if (pts.length < 2) return null;
    const t0 = pts[0].ts;
    const t1 = pts[pts.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const maxY = Math.max(...pts.map((s) => Math.max(s.uParcWh as number, s.besoinWh as number)));
    const x = (ts: number) => ((ts - t0) / span) * CHART_W;
    const y = (wh: number) => CHART_H - (wh / maxY) * (CHART_H - 10);
    const line = (pick: (s: CriterionSample) => number) =>
      pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.ts).toFixed(1)} ${y(pick(s)).toFixed(1)}`).join(' ');
    // Bandes de chauffe réelle (fond) — segments contigus heating.
    const bands: { x0: number; x1: number }[] = [];
    let start: number | null = null;
    for (const s of samples) {
      if (s.heating && start === null) start = s.ts;
      if (!s.heating && start !== null) {
        bands.push({ x0: x(start), x1: x(s.ts) });
        start = null;
      }
    }
    if (start !== null) bands.push({ x0: x(start), x1: CHART_W });
    return {
      parc: line((s) => s.uParcWh as number),
      besoin: line((s) => s.besoinWh as number),
      bands,
      t0,
      t1,
      maxY
    };
  });
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4">
  <a href="/menu/eau-chaude" class="text-[12px] font-medium" style="color: var(--color-primary);">
    ← Eau chaude
  </a>
  <header class="flex flex-col gap-1">
    <h1 class="text-2xl font-semibold tracking-tight">Labo — critère énergie</h1>
    <p class="text-[13px]" style="color: var(--color-muted-fg);">
      Le critère face au réel, tick par tick. C'est ce journal qui décidera du retrait des anciens
      seuils.
    </p>
  </header>

  {#if !cur}
    <div
      class="rounded-[var(--radius-2xl)] border p-4 text-sm"
      style="background: var(--color-card); border-color: var(--color-border); color: var(--color-muted-fg);"
    >
      {cumulusLabo.status === 'error'
        ? `Le journal ne répond pas (${cumulusLabo.lastError}).`
        : 'Chargement du journal…'}
    </div>
  {:else}
    <!-- ═══ Verdict à l'instant ═══ -->
    <section
      class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[15px] font-semibold" style="color: var(--color-fg);">
          {cur.energyOk
            ? '✓ Le critère autorise la chauffe'
            : manqueWh !== null
              ? `Il manque ${kWh(manqueWh)} au parc`
              : 'Bilan indisponible (source muette)'}
        </span>
        <span class="text-[12px] tabular-nums" style="color: var(--color-muted-fg);">
          {fmtTime(cur.ts)} · réel : {cur.heating ? 'chauffe' : cur.relayOn ? 'allumé' : 'éteint'}
        </span>
      </div>

      <!-- Barre : le besoin (3 segments) et le repère du parc -->
      {#if barScale}
        <div class="flex flex-col gap-1.5">
          <div
            class="relative h-5 overflow-hidden rounded-full"
            style="background: color-mix(in oklch, var(--color-muted-fg) 12%, transparent);"
          >
            <div class="absolute inset-y-0 left-0 flex" style="width: {segPct(cur.besoinWh)}%;">
              <div
                style="width: {cur.besoinWh
                  ? ((cur.eChauffeWh ?? 0) / cur.besoinWh) * 100
                  : 0}%; background: color-mix(in oklch, var(--color-hp) 75%, transparent);"
              ></div>
              <div
                style="width: {cur.besoinWh
                  ? ((cur.reserveWh ?? 0) / cur.besoinWh) * 100
                  : 0}%; background: color-mix(in oklch, var(--color-consumption) 70%, transparent);"
              ></div>
              <div
                style="width: {cur.besoinWh
                  ? ((tamponWh ?? 0) / cur.besoinWh) * 100
                  : 0}%; background: color-mix(in oklch, var(--color-muted-fg) 45%, transparent);"
              ></div>
            </div>
            <div
              class="absolute inset-y-0 w-[3px] rounded-full"
              style="left: calc({segPct(
                cur.uParcWh
              )}% - 1.5px); background: var(--color-glow); box-shadow: 0 0 8px var(--color-glow);"
              title="Énergie utilisable du parc"
            ></div>
          </div>
          <div
            class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] tabular-nums"
            style="color: var(--color-muted-fg);"
          >
            <span
              ><span class="dot" style="background: var(--color-hp);"></span> chauffe {kWh(
                cur.eChauffeWh
              )}</span
            >
            <span
              ><span class="dot" style="background: var(--color-consumption);"></span> soirée {kWh(
                cur.reserveWh
              )}</span
            >
            <span
              ><span class="dot" style="background: var(--color-muted-fg);"></span> tampon {kWh(
                tamponWh
              )}</span
            >
            <span
              ><span class="dot" style="background: var(--color-glow);"></span> parc {kWh(
                cur.uParcWh
              )}</span
            >
          </div>
        </div>
      {/if}
    </section>

    <!-- ═══ La journée : parc vs besoin, chauffes en fond ═══ -->
    {#if chart}
      <section
        class="flex flex-col gap-2 rounded-[var(--radius-2xl)] border p-4"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-baseline justify-between">
          <span class="text-[13px] font-semibold" style="color: var(--color-fg);"
            >Le parc face au besoin</span
          >
          <span class="text-[11px] tabular-nums" style="color: var(--color-muted-fg);"
            >{fmtTime(chart.t0)} → {fmtTime(chart.t1)}</span
          >
        </div>
        <svg
          viewBox="0 0 {CHART_W} {CHART_H}"
          class="w-full"
          style="height: 130px;"
          preserveAspectRatio="none"
          role="img"
          aria-label="Énergie du parc et besoin total au fil de la journée"
        >
          {#each chart.bands as b (b.x0)}
            <rect
              x={b.x0}
              y="0"
              width={Math.max(1, b.x1 - b.x0)}
              height={CHART_H}
              style="fill: color-mix(in oklch, var(--color-hp) 14%, transparent);"
            />
          {/each}
          <path d={chart.besoin} fill="none" style="stroke: var(--color-hp);" stroke-width="2" />
          <path d={chart.parc} fill="none" style="stroke: var(--color-glow);" stroke-width="2" />
        </svg>
        <div class="flex gap-4 text-[11.5px]" style="color: var(--color-muted-fg);">
          <span
            ><span class="dot" style="background: var(--color-glow);"></span> parc utilisable</span
          >
          <span
            ><span class="dot" style="background: var(--color-hp);"></span> besoin (chauffe + soirée +
            tampon)</span
          >
          <span
            ><span
              class="dot"
              style="background: color-mix(in oklch, var(--color-hp) 30%, transparent);"
            ></span> chauffe réelle</span
          >
        </div>
        <p class="text-[12px]" style="color: var(--color-muted-fg);">
          Quand la ligne verte croise la ligne corail, le critère autorise — la chauffe doit suivre
          sans acheter un watt.
        </p>
      </section>
    {/if}

    <!-- ═══ Le duel des voies + le juge de paix ═══ -->
    <section
      class="flex flex-col gap-2.5 rounded-[var(--radius-2xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span class="text-[13px] font-semibold" style="color: var(--color-fg);"
        >Sur la fenêtre chargée ({samples.length} ticks)</span
      >
      <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[13px]">
        <dt style="color: var(--color-muted-fg);">Autorisé par le critère énergie seul</dt>
        <dd class="text-right font-semibold tabular-nums" style="color: var(--color-glow);">
          {cumulusLabo.energyOnly} ticks
        </dd>
        <dt style="color: var(--color-muted-fg);">Par les anciennes voies seules</dt>
        <dd class="text-right font-semibold tabular-nums" style="color: var(--color-fg);">
          {cumulusLabo.legacyOnly} ticks
        </dd>
        <dt style="color: var(--color-muted-fg);">Par les deux</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-muted-fg);">
          {cumulusLabo.both} ticks
        </dd>
        <dt style="color: var(--color-muted-fg);">Chauffe solaire pilotée</dt>
        <dd class="text-right tabular-nums" style="color: var(--color-muted-fg);">
          {cumulusLabo.heatMin} min
        </dd>
        <dt style="color: var(--color-muted-fg);">Achat EDF pendant ces chauffes</dt>
        <dd
          class="text-right font-semibold tabular-nums"
          style="color: {cumulusLabo.buyDuringHeatWh > 50
            ? 'var(--color-warning)'
            : 'var(--color-success)'};"
        >
          {cumulusLabo.buyDuringHeatWh} Wh
        </dd>
      </dl>
      <p class="text-[12px]" style="color: var(--color-muted-fg);">
        Comparaison faite fenêtre solaire ouverte et relais au repos — hors recharges de nuit (qui
        achètent exprès au tarif creux) et hors chauffes forcées. Les anciens seuils pourront être
        retirés quand « anciennes voies seules » restera à zéro et que l'achat EDF pendant les
        chauffes solaires restera négligeable, sur plusieurs jours.
      </p>
    </section>
  {/if}
</div>

<style>
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    margin-right: 4px;
    vertical-align: baseline;
  }
</style>
