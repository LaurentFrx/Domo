<script lang="ts">
  /**
   * Pop-up « historique de température 4 h » — monté UNE fois dans le layout,
   * piloté par le store global `tempHistory`. Trace la courbe des 4 dernières
   * heures (lissée, d3-shape via $utils/chart) + repères min / max / actuel.
   *
   * Données : GET /api/temperature/history (recollectées à chaque ouverture).
   * Couleur chaud↔froid interpolée en oklch LITTÉRAL (Safari iOS : jamais de
   * color-mix). Vide juste après un déploiement (l'historique se constitue).
   */
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import { tempHistory } from '$stores/temp-history.svelte';
  import { smoothLinePath, smoothAreaPath, type XY } from '$utils/chart';

  // Géométrie SVG (viewBox étiré, stroke non-scaling — modèle page Énergie).
  const SVG_W = 300;
  const TOP_Y = 12;
  const BASE_Y = 108;
  const CHART_H = BASE_Y - TOP_Y;

  type Pt = { ts: number; c: number | null };

  let loading = $state(false);
  let error = $state(false);
  let points = $state<Pt[]>([]);

  // Recharge à chaque ouverture (la fenêtre glisse, les données changent).
  $effect(() => {
    if (!tempHistory.open || !tempHistory.sensorKey) return;
    const key = tempHistory.sensorKey;
    loading = true;
    error = false;
    points = [];
    const ac = new AbortController();
    fetch(`/api/temperature/history?sensor=${encodeURIComponent(key)}&hours=4`, {
      signal: ac.signal
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { points?: Pt[] };
        if (!r.ok) throw new Error('http');
        points = Array.isArray(d.points) ? d.points : [];
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') error = true;
      })
      .finally(() => {
        loading = false;
      });
    return () => ac.abort();
  });

  // Échantillons valides (non-null) — on relie au travers des trous éventuels.
  const valid = $derived(
    points.filter((p): p is { ts: number; c: number } => typeof p.c === 'number')
  );

  const stats = $derived.by(() => {
    if (valid.length === 0) return null;
    const cs = valid.map((p) => p.c);
    const min = Math.min(...cs);
    const max = Math.max(...cs);
    const current = cs[cs.length - 1];
    return { min, max, current, delta: current - cs[0] };
  });

  const geom = $derived.by(() => {
    if (valid.length < 2) return null;
    const tMin = valid[0].ts;
    const tMax = valid[valid.length - 1].ts;
    const tSpan = Math.max(1, tMax - tMin);
    const cs = valid.map((p) => p.c);
    let lo = Math.min(...cs);
    let hi = Math.max(...cs);
    const pad = Math.max(0.5, (hi - lo) * 0.18);
    lo -= pad;
    hi += pad;
    const cSpan = Math.max(0.1, hi - lo);
    const xy: XY[] = valid.map((p) => ({
      x: ((p.ts - tMin) / tSpan) * SVG_W,
      y: BASE_Y - ((p.c - lo) / cSpan) * CHART_H
    }));
    return { tMin, tMax, line: smoothLinePath(xy), area: smoothAreaPath(xy, BASE_Y) };
  });

  /** Teinte chaud↔froid (oklch littéral) : ~8 °C froid (hue 210) → ~28 °C chaud (hue 30). */
  function tempColor(t: number): string {
    const f = Math.max(0, Math.min(1, (t - 8) / 20));
    const hue = Math.round(210 + f * (30 - 210));
    return `oklch(0.72 0.17 ${hue})`;
  }
  const color = $derived(stats ? tempColor(stats.current) : 'var(--color-primary)');

  const fmtC = (t: number) => `${t.toFixed(1).replace('.', ',')} °C`;
  function fmtTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  const xLabels = $derived.by(() => {
    if (!geom) return [];
    return [0, 1, 2, 3].map((i) => fmtTime(geom.tMin + ((geom.tMax - geom.tMin) * i) / 3));
  });
</script>

<BottomSheet
  open={tempHistory.open}
  title={`${tempHistory.label} · 4 h`}
  onClose={() => tempHistory.close()}
>
  {#if loading}
    <div class="th-state">
      <span class="th-ring" aria-hidden="true"></span>
      <p>Chargement de l'historique…</p>
    </div>
  {:else if error}
    <div class="th-state">
      <p>Historique indisponible pour l'instant.</p>
    </div>
  {:else if !geom || !stats}
    <div class="th-state">
      <p>Pas encore assez de mesures.</p>
      <p class="th-hint">
        L'historique se constitue minute par minute (vide juste après un déploiement).
      </p>
    </div>
  {:else}
    <!-- Bandeau de repères -->
    <div class="th-stats">
      <div class="th-stat th-cur">
        <span class="th-k">Actuel</span>
        <span class="th-v" style="color: {color};">{fmtC(stats.current)}</span>
      </div>
      <div class="th-stat">
        <span class="th-k">Min</span>
        <span class="th-v th-sm">{fmtC(stats.min)}</span>
      </div>
      <div class="th-stat">
        <span class="th-k">Max</span>
        <span class="th-v th-sm">{fmtC(stats.max)}</span>
      </div>
      <div class="th-stat">
        <span class="th-k">Évolution</span>
        <span class="th-v th-sm">
          {stats.delta >= 0 ? '+' : '−'}{Math.abs(stats.delta).toFixed(1).replace('.', ',')} °C
        </span>
      </div>
    </div>

    <!-- Courbe -->
    <svg
      viewBox="0 0 {SVG_W} 120"
      class="th-svg block w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Courbe de température des 4 dernières heures"
    >
      <path d={geom.area} fill={color} opacity="0.12" />
      <path
        d={geom.line}
        fill="none"
        stroke={color}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <div class="th-xaxis">
      {#each xLabels as t (t)}
        <span>{t}</span>
      {/each}
    </div>
  {/if}
</BottomSheet>

<style>
  .th-svg {
    height: 168px;
  }
  .th-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
  }
  .th-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .th-k {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-muted-fg);
  }
  .th-v {
    font-size: 20px;
    font-weight: 700;
    color: var(--color-fg);
    line-height: 1.1;
  }
  .th-v.th-sm {
    font-size: 15px;
    font-weight: 600;
  }
  .th-cur .th-v {
    font-size: 22px;
  }
  .th-xaxis {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--color-muted-fg);
    margin-top: -4px;
  }
  .th-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.5rem 0.5rem;
    text-align: center;
    color: var(--color-muted-fg);
    font-size: 13px;
  }
  .th-hint {
    font-size: 11px;
    opacity: 0.8;
    max-width: 22rem;
  }
  .th-ring {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2.5px solid var(--color-border);
    border-top-color: var(--color-primary);
    animation: th-spin 0.8s linear infinite;
  }
  @keyframes th-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .th-ring {
      animation: none;
      border-top-color: var(--color-border);
      border-color: var(--color-primary);
      opacity: 0.6;
    }
  }
</style>
