<script lang="ts">
  /**
   * Graphe « Réseau & cumulus 24 h » — mesure LOCALE de l'EM-50 (domo-recorder).
   *
   * Pendant du graphe Production : ici on montre ce qu'on ÉCHANGE avec le réseau,
   * courbe SIGNÉE centrée sur 0 → soutirage EDF au-dessus (rouge), injection PV
   * (surplus) en dessous (vert) ; plus la conso cumulus du jour. Source : store
   * em50History (/api/em50/history). État « en attente » tant qu'< 2 points.
   *
   * Géométrie/style calqués sur le graphe Production de la page Énergie (viewBox
   * 240×120, courbes lissées d3-shape, ChartHoverLayer, dégradé d'aire). L'effet
   * verre vient de src/app.css via [style*='background: var(--color-card)'].
   */
  import { em50History } from '$stores/em50History.svelte';
  import { smoothLinePath, smoothAreaPath, nearestIndex } from '$utils/chart';
  import ChartHoverLayer from './ChartHoverLayer.svelte';
  import { formatPower } from '$utils/format';

  const SVG_W = 240;
  const ZERO_Y = 60; // ligne 0 (médiane) : + au-dessus, − en dessous
  const HALF = 48; // amplitude verticale max de part et d'autre de 0

  function hhmm(tsSec: number): string {
    return new Date(tsSec * 1000).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Points réseau (W signés) non nuls. reduce (pas de spread) → robuste sur 24 h.
  const pts = $derived(em50History.points.filter((p) => p.em50_grid_w != null));
  const maxAbs = $derived(
    Math.max(
      200,
      pts.reduce((m, p) => Math.max(m, Math.abs(p.em50_grid_w as number)), 0)
    ) * 1.12
  );

  const view = $derived.by(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].ts;
    const t1 = pts[pts.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const xy = pts.map((p) => ({
      x: ((p.ts - t0) / span) * SVG_W,
      y: ZERO_Y - ((p.em50_grid_w as number) / maxAbs) * HALF
    }));
    const ticks = Array.from({ length: 4 }, (_, i) => hhmm(t0 + (span * i) / 3));
    return { xy, ticks };
  });

  const line = $derived(view ? smoothLinePath(view.xy) : '');
  const area = $derived(view ? smoothAreaPath(view.xy, ZERO_Y) : '');

  // ── Survol → étiquette flottante (valeur signée + heure) ──
  let hover = $state<number | null>(null);
  function onMove(e: MouseEvent) {
    if (!view) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    hover = nearestIndex(view.xy, frac, SVG_W);
  }
  const hoverView = $derived.by(() => {
    if (hover == null || !view) return null;
    const i = Math.min(hover, view.xy.length - 1);
    const pt = view.xy[i];
    const p = pts[i];
    if (!pt || !p) return null;
    const w = p.em50_grid_w as number;
    const label = `${w >= 0 ? '↑ ' : '↓ '}${formatPower(Math.abs(w))} · ${hhmm(p.ts)}`;
    return { xPct: (pt.x / SVG_W) * 100, yPct: (pt.y / 120) * 100, label };
  });

  const t = em50History.today;
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex items-center justify-between gap-2">
    <div class="flex flex-col gap-0.5">
      <span class="text-[14px] font-semibold">Réseau & cumulus 24h</span>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Compteur EM-50 · mesure locale
      </span>
    </div>
    <div class="flex flex-col items-end gap-0.5 text-[11px] font-semibold tabular-nums">
      <span style="color: var(--color-grid-energy);">↑ {t.import_kwh.toFixed(1)} kWh soutirés</span>
      <span style="color: var(--color-solar);">↓ {t.export_kwh.toFixed(1)} kWh injectés</span>
    </div>
  </div>

  {#if view}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative"
      style="height: 150px;"
      role="presentation"
      onmousemove={onMove}
      onmouseleave={() => (hover = null)}
    >
      <svg
        viewBox="0 0 240 120"
        class="block w-full"
        style="height: 150px;"
        preserveAspectRatio="none"
      >
        <defs>
          <!-- Rouge (soutirage) en haut → vert (injection) en bas, autour de la ligne 0. -->
          <linearGradient id="em50Grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style="stop-color: var(--color-grid-energy); stop-opacity: 0.28;" />
            <stop offset="50%" style="stop-color: var(--color-grid-energy); stop-opacity: 0.04;" />
            <stop offset="50%" style="stop-color: var(--color-solar); stop-opacity: 0.04;" />
            <stop offset="100%" style="stop-color: var(--color-solar); stop-opacity: 0.26;" />
          </linearGradient>
        </defs>

        <!-- Aire signée (remplie jusqu'à la ligne 0) + courbe. -->
        <path d={area} fill="url(#em50Grad)" />
        <path
          d={line}
          fill="none"
          stroke="var(--color-fg)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.75"
          vector-effect="non-scaling-stroke"
        />
        <!-- Ligne 0 (frontière soutirage / injection). -->
        <line
          x1="0"
          y1={ZERO_Y}
          x2="240"
          y2={ZERO_Y}
          stroke="var(--color-border-strong)"
          stroke-width="1"
          stroke-dasharray="2 4"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <!-- Repères haut/bas (sens du flux). -->
      <span
        class="pointer-events-none absolute top-0 left-1 text-[9px]"
        style="color: var(--color-grid-energy);">soutiré</span
      >
      <span
        class="pointer-events-none absolute bottom-0 left-1 text-[9px]"
        style="color: var(--color-solar);">injecté</span
      >
      <ChartHoverLayer
        show={!!hoverView}
        xPct={hoverView?.xPct ?? 0}
        yPct={hoverView?.yPct ?? 0}
        label={hoverView?.label ?? ''}
      />
    </div>

    <div class="flex justify-between text-[10px]" style="color: var(--color-muted-fg);">
      {#each view.ticks as label, i (i)}
        <span>{label}</span>
      {/each}
    </div>
  {:else}
    <div
      class="flex items-center justify-center text-[12px]"
      style="height: 150px; color: var(--color-muted-fg);"
    >
      En attente de données…
    </div>
  {/if}

  <!-- Conso cumulus du jour (mesure EM-50). -->
  <div
    class="flex items-center justify-between border-t pt-2.5 text-[12px]"
    style="border-color: var(--color-border);"
  >
    <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
      <span class="h-2 w-2 rounded-full" style="background: var(--color-hp);"></span>
      Cumulus aujourd'hui
    </span>
    <span class="font-semibold tabular-nums" style="color: var(--color-fg);"
      >{t.cumulus_kwh.toFixed(2)} kWh</span
    >
  </div>
</section>
