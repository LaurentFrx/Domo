<script lang="ts">
  /**
   * Pop-up « historique de température 4 h » — monté UNE fois dans le layout,
   * piloté par le store global `tempHistory`. Trace la courbe des 4 dernières
   * heures + repères min / max / actuel.
   *
   * - Série LISSÉE (moyenne glissante `smoothSeries`) avant tracé → courbe
   *   dérivable, sans « escalier » (les sondes tiennent leur valeur entre deux
   *   événements, d'où des marches dans le brut).
   * - Couleur = ÉTAT de CONFORT (pas la seule température absolue) : un dégradé
   *   le long de la courbe va du froid (cyan) au confort (vert) au chaud
   *   (corail), centré sur la zone de confort du capteur (renvoyée par l'API).
   *   oklch LITTÉRAL, chroma toujours élevé (Safari iOS, jamais d'ocre terne).
   *
   * Vide juste après un déploiement (l'historique se constitue).
   */
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import { tempHistory } from '$stores/temp-history.svelte';
  import { smoothLinePath, smoothAreaPath, smoothSeries, type XY } from '$utils/chart';

  // Géométrie SVG (viewBox étiré, stroke non-scaling — modèle page Énergie).
  const SVG_W = 300;
  const TOP_Y = 12;
  const BASE_Y = 108;
  const CHART_H = BASE_Y - TOP_Y;

  type Pt = { ts: number; c: number | null };

  let loading = $state(false);
  let error = $state(false);
  let points = $state<Pt[]>([]);
  // Zone de confort [min, max] °C du capteur (centre du dégradé). Défaut = pièce.
  let band = $state<[number, number]>([19, 24]);

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
        const d = (await r.json().catch(() => ({}))) as {
          points?: Pt[];
          comfort?: [number, number];
        };
        if (!r.ok) throw new Error('http');
        points = Array.isArray(d.points) ? d.points : [];
        if (Array.isArray(d.comfort) && d.comfort.length === 2) band = d.comfort;
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
    // Lissage : transforme les marches (sample-and-hold) en pentes douces.
    // Fenêtre adaptée à la densité (≈11 points autour), bornée pour rester réactif.
    const half = Math.max(1, Math.min(5, Math.round(valid.length / 24)));
    const cs = smoothSeries(
      valid.map((p) => p.c),
      half
    );
    let lo = Math.min(...cs);
    let hi = Math.max(...cs);
    const pad = Math.max(0.5, (hi - lo) * 0.18);
    lo -= pad;
    hi += pad;
    const cSpan = Math.max(0.1, hi - lo);
    const xy: XY[] = valid.map((p, i) => ({
      x: ((p.ts - tMin) / tSpan) * SVG_W,
      y: BASE_Y - ((cs[i] - lo) / cSpan) * CHART_H
    }));
    return { tMin, tMax, lo, hi, line: smoothLinePath(xy), area: smoothAreaPath(xy, BASE_Y) };
  });

  // ─── Couleur = ÉTAT de CONFORT ────────────────────────────────────────────
  // Centre = vert lumineux (dans la zone de confort) ; glisse vers cyan quand
  // c'est trop froid, vers corail quand c'est trop chaud. Tous accents charte,
  // chroma ≥0.15 (jamais d'ocre terne). Interp oklch L/C/H linéaire.
  type LCH = [number, number, number];
  const C_COMFORT: LCH = [0.84, 0.19, 150]; // vert lumineux
  const C_COLD: LCH = [0.8, 0.15, 205]; // cyan
  const C_HOT: LCH = [0.75, 0.19, 32]; // corail
  function lch(c: LCH): string {
    return `oklch(${c[0]} ${c[1]} ${c[2]})`;
  }
  function mix(a: LCH, b: LCH, f: number): string {
    const g = Math.max(0, Math.min(1, f));
    return `oklch(${(a[0] + g * (b[0] - a[0])).toFixed(3)} ${(a[1] + g * (b[1] - a[1])).toFixed(3)} ${(a[2] + g * (b[2] - a[2])).toFixed(1)})`;
  }
  function comfortColor(t: number): string {
    const [cmin, cmax] = band;
    if (t < cmin) return mix(C_COMFORT, C_COLD, (cmin - t) / 7);
    if (t > cmax) return mix(C_COMFORT, C_HOT, (t - cmax) / 9);
    return lch(C_COMFORT);
  }
  const color = $derived(stats ? comfortColor(stats.current) : 'var(--color-primary)');

  // Arrêts du dégradé vertical (userSpaceOnUse) : la couleur suit la TEMPÉRATURE
  // (axe Y), pas l'instant → chaque portion de courbe prend sa teinte d'état.
  const gradStops = $derived.by(() => {
    if (!geom) return [];
    const N = 14;
    return Array.from({ length: N + 1 }, (_, k) => {
      const off = k / N; // 0 = haut (hi) … 1 = bas (lo)
      const t = geom.hi - off * (geom.hi - geom.lo);
      return { offset: +(off * 100).toFixed(1), color: comfortColor(t) };
    });
  });

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
      <defs>
        <!-- Dégradé d'état : froid (haut/bas selon T) → confort → chaud, mappé
             sur l'axe température (userSpaceOnUse → partagé courbe + aire). -->
        <linearGradient
          id="thGrad"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={TOP_Y}
          x2="0"
          y2={BASE_Y}
        >
          {#each gradStops as s (s.offset)}
            <stop offset="{s.offset}%" stop-color={s.color} />
          {/each}
        </linearGradient>
      </defs>
      <path d={geom.area} fill="url(#thGrad)" opacity="0.18" />
      <path
        d={geom.line}
        fill="none"
        stroke="url(#thGrad)"
        stroke-width="2.25"
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
