<script lang="ts">
  import { forecast } from '$stores/forecast.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { apsystems } from '$stores/apsystems.svelte';
  import { anker } from '$stores/anker.svelte';
  import { production } from '$stores/production.svelte';
  import { productionHistory } from '$stores/productionHistory.svelte';
  import { savings } from '$stores/savings.svelte';
  import { settings } from '$stores/settings.svelte';
  import { energyMonthly } from '$stores/energyMonthly.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { matter } from '$stores/matter.svelte';
  import { formatPower, formatCurrency } from '$utils/format';
  import {
    smoothLinePath,
    smoothAreaPath,
    smoothSeries,
    nearestIndex,
    type XY
  } from '$utils/chart';
  import { onMount, onDestroy } from 'svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import ChartHoverLayer from '$components/charts/ChartHoverLayer.svelte';
  import ApplianceCard from '$components/tiles/ApplianceCard.svelte';
  import CumulusCard from '$components/cards/CumulusCard.svelte';

  onMount(() => {
    settings.hydrate(); // coût installation (ROI) + prix, depuis /api/settings
    zigbee.connect();
    matter.connect(); // prises Matter mesurées (Bureau multimédia, Home cinéma) — conso
    forecast.connect();
    // anker ET apsystems sont désormais connectés app-wide par +layout.svelte
    // (leur production entre dans le bilan de l'accueil). connect() est idempotent
    // → on les rappelle sans risque, MAIS on ne les disconnect PAS ici (sinon on
    // couperait le polling global au départ de la page).
    apsystems.connect();
    anker.connect();
    productionHistory.connect();
    // Ventilation mensuelle (tableau + KPI). savings est déjà connecté app-wide
    // par +layout.svelte (utilisé pour le ROI annuel) → pas besoin ici.
    energyMonthly.connect();
    // Relais cumulus RÉEL (Shelly Pro 1) — état + on/off dans CumulusCard.
    cumulus.connectRelay();
    // Orchestrateur (mode, raison de décision, énergie réelle, anomalie).
    cumulus.connectOrchestrator();
  });
  onDestroy(() => {
    zigbee.disconnect();
    matter.disconnect();
    forecast.disconnect();
    productionHistory.disconnect();
    energyMonthly.disconnect();
    cumulus.disconnectRelay();
    cumulus.disconnectOrchestrator();
    // Pas de anker.disconnect() ni apsystems.disconnect() : leur cycle de vie
    // appartient au layout racine (utilisés app-wide, notamment par le dashboard).
  });

  // Prises Zigbee suivies pour la conso électroménager (Frigo, Lave-linge).
  const TRACKED_APPLIANCES = new Set(['frigo', 'lave-linge', 'lave_vaisselle']);
  const appliancePlugs = $derived(
    zigbee.devices.filter(
      (d) => d.category === 'plug' && TRACKED_APPLIANCES.has(d.friendlyName.toLowerCase())
    )
  );
  // Prises Matter à mesure de puissance suivies dans la conso : node 22 = Bureau
  // multimédia, node 26 = Home cinéma (cluster 144). Disponibles uniquement.
  const TRACKED_MATTER_PLUGS = new Set([22, 26]);
  const matterPlugs = $derived(
    matter.switches.filter((s) => TRACKED_MATTER_PLUGS.has(s.nodeId) && s.available)
  );

  // ─── Section 1 : production RÉELLE (domo-recorder) ──────────────────
  // Graphe mono-série : la production réelle de /api/production/history.
  // Axe X = fenêtre temporelle réelle des points (min→max ts, glissante sur
  // ~24h), axe Y = kW.

  // Géométrie du SVG (viewBox 240×120). Aire de production depuis le BAS, sur
  // (quasi) toute la hauteur — fini le demi-graphe vide de l'ancien design 2 séries.
  const SVG_W = 240;
  const BASE_Y = 116; // ligne de base près du bas (petite marge anti-rognage)
  const TOP_Y = 8; // marge haute au-dessus du pic
  const CHART_H = BASE_Y - TOP_Y; // hauteur utile du tracé (~108 px)

  function hhmm(tsSec: number): string {
    return new Date(tsSec * 1000).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Graduations Y « rondes » selon l'échelle max (kW) — partagé S1 + Prévisions.
  function yTickValues(maxKw: number): number[] {
    const step = maxKw <= 1 ? 0.25 : maxKw <= 2 ? 0.5 : maxKw <= 5 ? 1 : 2;
    const out: number[] = [];
    for (let v = step; v < maxKw - 1e-6; v += step) out.push(v);
    return out;
  }

  // Lissage RÉGLABLE de la production (moyenne glissante centrée ; ½-fenêtre en
  // échantillons ~2 min ; 0 = brut). Persisté dans les préférences (curseur sous le graphe).
  const prodKwSmoothed = $derived(
    smoothSeries(
      productionHistory.points.map((p) => Math.max(0, (p.production_w ?? 0) / 1000)),
      preferences.productionSmoothHalf
    )
  );

  // Échelle Y (kW) : auto sur le pic (lissé) + 10 % de marge, plancher 1 kW.
  const prodKwMax = $derived(prodKwSmoothed.reduce((m, v) => Math.max(m, v), 0));
  const yMaxKw = $derived(Math.max(1, prodKwMax * 1.1));

  // Vue dérivée de la série réelle. null si 0-1 point → état « en attente ».
  const prodView = $derived.by(() => {
    const pts = productionHistory.points;
    if (pts.length < 2) return null;
    const t0 = pts[0].ts;
    const t1 = pts[pts.length - 1].ts;
    const span = Math.max(1, t1 - t0); // évite une division par 0
    const xy = pts.map((p, i) => ({
      x: ((p.ts - t0) / span) * SVG_W,
      y: BASE_Y - ((prodKwSmoothed[i] ?? 0) / yMaxKw) * CHART_H
    }));
    // 4 graduations HH:MM réparties uniformément sur la plage temporelle.
    const ticks = Array.from({ length: 4 }, (_, i) => hhmm(t0 + (span * i) / 3));
    return { xy, ticks };
  });

  // Courbe lissée (spline monotone, façon Recharts/Yeldra) via d3-shape.
  const prodLine = $derived(prodView ? smoothLinePath(prodView.xy) : '');
  const prodArea = $derived(prodView ? smoothAreaPath(prodView.xy, BASE_Y) : '');

  // Énergie cumulée sur la fenêtre (kWh) — intégration trapézoïdale des échantillons
  // de puissance (∑ (P[i]+P[i-1])/2 × Δt).
  const dayKwh = $derived.by(() => {
    const pts = productionHistory.points;
    let wh = 0;
    for (let i = 1; i < pts.length; i++) {
      const dtH = (pts[i].ts - pts[i - 1].ts) / 3600;
      wh += (((pts[i].production_w ?? 0) + (pts[i - 1].production_w ?? 0)) / 2) * dtH;
    }
    return wh / 1000;
  });

  // Repères Y : valeur kW ronde → position SVG (y) + position HTML (topPct %) + label.
  const yTicks = $derived(
    yTickValues(yMaxKw).map((kw) => {
      const y = BASE_Y - (kw / yMaxKw) * CHART_H;
      return { kw, y, topPct: (y / 120) * 100, label: `${parseFloat(kw.toFixed(2))} kW` };
    })
  );

  // Repères X discrets (verticaux), alignés sur les 2 graduations HH:MM intérieures.
  const gridX = [SVG_W / 3, (2 * SVG_W) / 3];

  // ── Survol : index du point sous le curseur → étiquette flottante (valeur + heure).
  let prodHover = $state<number | null>(null);
  function onProdMove(e: MouseEvent) {
    if (!prodView) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    prodHover = nearestIndex(prodView.xy, frac, SVG_W);
  }
  const prodHoverView = $derived.by(() => {
    if (prodHover == null || !prodView) return null;
    const i = Math.min(prodHover, prodView.xy.length - 1);
    const pt = prodView.xy[i];
    const data = productionHistory.points[i];
    if (!pt || !data) return null;
    return {
      xPct: (pt.x / SVG_W) * 100,
      yPct: (pt.y / 120) * 100,
      label: `${formatPower((prodKwSmoothed[i] ?? 0) * 1000)} · ${hhmm(data.ts)}`
    };
  });

  // ─── Section 2 : Prévision PV 48h — forecast-bridge (Open-Meteo + PVLib) ──
  const fc = $derived(forecast.points.slice(0, 48));
  const maxKw = $derived(Math.max(...fc.map((p) => p.kw), 0.1));

  // Points {x,y} d'une série (Total = sud + ouest, écrêté onduleur/SB).
  function fcXY(prop: 'kw' | 'kwSud' | 'kwOuest'): XY[] {
    const w = fc.length - 1 || 1;
    return fc.map((p, i) => ({
      x: (i / w) * 480,
      y: 80 - (Math.max(0, p[prop]) / maxKw) * 70
    }));
  }
  // Courbes lissées (spline monotone), harmonisées avec la production.
  function pvLine(prop: 'kw' | 'kwSud' | 'kwOuest'): string {
    return smoothLinePath(fcXY(prop));
  }
  function pvArea(): string {
    return smoothAreaPath(fcXY('kw'), 80);
  }

  // Repères Y du graphe Prévisions (mêmes valeurs kW rondes que la prod).
  const fcTicks = $derived(
    yTickValues(maxKw).map((kw) => {
      const y = 80 - (kw / maxKw) * 70;
      return { kw, y, topPct: (y / 90) * 100, label: `${parseFloat(kw.toFixed(2))} kW` };
    })
  );
  const fcGridX = [120, 240, 360];

  // ── Survol prévisions → étiquette flottante (Total + heure).
  let fcHover = $state<number | null>(null);
  function fcTime(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  function onFcMove(e: MouseEvent) {
    const xy = fcXY('kw');
    if (xy.length < 2) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    fcHover = nearestIndex(xy, frac, 480);
  }
  const fcHoverView = $derived.by(() => {
    if (fcHover == null) return null;
    const xy = fcXY('kw');
    const i = Math.min(fcHover, xy.length - 1);
    const pt = xy[i];
    const data = fc[i];
    if (!pt || !data) return null;
    return {
      xPct: (pt.x / 480) * 100,
      yPct: (pt.y / 90) * 100,
      label: `${formatPower(data.kw * 1000)} · ${fcTime(data.time)}`
    };
  });

  // ─── Section 3 : Tableau mensuel (données RÉELLES : store energyMonthly) ──
  const months = [
    'Jan',
    'Fév',
    'Mar',
    'Avr',
    'Mai',
    'Juin',
    'Jui',
    'Aoû',
    'Sep',
    'Oct',
    'Nov',
    'Déc'
  ];
  const now = new Date();
  const currentMonthIdx = now.getMonth();
  // En-tête : nom de mois plein, capitalisé (« Juin », « Janvier »…).
  const monthTitle = (() => {
    const m = now.toLocaleDateString('fr-FR', { month: 'long' });
    return m.charAt(0).toUpperCase() + m.slice(1);
  })();

  // Lignes du tableau dérivées des 12 mois agrégés (kWh / €). « — » géré au rendu.
  const rows = $derived<{ label: string; values: number[]; unit: string }[]>([
    {
      label: 'Production PV',
      values: energyMonthly.months.map((m) => m.production_kwh),
      unit: 'kWh'
    },
    {
      label: 'Autoconsommation',
      values: energyMonthly.months.map((m) => m.autoconso_kwh),
      unit: 'kWh'
    },
    {
      label: 'Surplus injecté',
      values: energyMonthly.months.map((m) => m.surplus_kwh),
      unit: 'kWh'
    },
    {
      label: 'Import réseau',
      values: energyMonthly.months.map((m) => m.import_kwh),
      unit: 'kWh'
    },
    {
      label: 'Économies',
      values: energyMonthly.months.map((m) => m.savings_eur),
      unit: '€'
    }
  ]);

  // ─── Section 4 : KPIs humanisés (mois courant réel) ─────────────────
  // Mois courant : auto-conso + import réels (store mensuel). ROI : économies
  // annuelles du store savings (baseline incluse, cohérent avec la SavingsCard).
  const curMonth = $derived(energyMonthly.months[currentMonthIdx] ?? energyMonthly.months[0]);
  // CO2 évité = auto-conso × facteur réseau FRANCE (réglage, défaut ADEME 0,052).
  const co2Saved = $derived((curMonth?.autoconso_kwh ?? 0) * settings.co2FactorKgKwh);
  const evKmEquiv = $derived(co2Saved * 6);
  const autonomyPct = $derived.by(() => {
    const auto = curMonth?.autoconso_kwh ?? 0;
    const denom = auto + (curMonth?.import_kwh ?? 0);
    return denom > 0 ? Math.round((100 * auto) / denom) : 0;
  });
  // ─── ROI : amortissement RÉEL ───────────────────────────────────────
  // Coût = réglage (Réglages). On tient compte de la part DÉJÀ AMORTIE par le
  // total des économies cumulées, et on projette le reste au taux annuel RÉALISÉ
  // (économies cumulées ÷ années écoulées depuis la mise en service).
  const installEur = $derived(settings.installationCostEur);
  const savedTotalEur = $derived(savings.total.eur);
  const amortizedPct = $derived(
    installEur > 0 ? Math.min(100, Math.round((100 * savedTotalEur) / installEur)) : 0
  );
  const remainingEur = $derived(Math.max(0, installEur - savedTotalEur));
  const yearsElapsed = $derived(
    Math.max(
      0.1,
      (Date.now() - new Date(settings.installationDateISO).getTime()) / (365.25 * 24 * 3600 * 1000)
    )
  );
  const annualSavingsEur = $derived(savedTotalEur / yearsElapsed);
  // Années RESTANTES jusqu'à l'amortissement complet (0 si déjà amorti).
  const roiYears = $derived(
    remainingEur <= 0 ? 0 : annualSavingsEur > 0 ? Math.round(remainingEur / annualSavingsEur) : 0
  );

  // Rendu d'une cellule : kWh arrondi (≥ 1), € via formatCurrency (≥ 0,005),
  // sinon tiret « — » (mois sans donnée, ou valeur négligeable).
  function fmtCell(v: number, unit: string): string {
    if (unit === '€') return v >= 0.005 ? formatCurrency(v) : '—';
    const r = Math.round(v);
    return r >= 1 ? r.toString() : '—';
  }
</script>

<svelte:head>
  <title>Énergie — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Énergie</h1>
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      Sanguinet · {monthTitle}
      {now.getFullYear()}
    </span>
  </header>

  <!-- ═══ Paysage (iPad/desktop) : production + prévisions côte à côte ═══ -->
  <div class="grid gap-6 lg:grid-cols-2 lg:items-start">
    <!-- ═══ Section 1 : Stacked area 24h ═══ -->
    <section
      class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col gap-0.5">
          <span class="text-[14px] font-semibold">Flux d'énergie 24h</span>
          <!-- Réseau soutiré du jour : déplacé depuis l'accueil (sa place = page énergie). -->
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            Aujourd'hui{#if savings.connected}
              · <span style="color: var(--color-grid-energy);"
                >↓ {savings.today.import_kwh.toFixed(2)} kWh réseau</span
              >{/if}
          </span>
        </div>
        {#if prodView}
          <span
            class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em]"
            style="background: var(--color-solar-muted); color: var(--color-solar);"
          >
            {dayKwh.toFixed(1)} kWh
          </span>
        {/if}
      </div>

      <!-- Production réelle instantanée = APS (bridge 8100) + SolarBank site (bridge 8095). -->
      <div class="flex items-end justify-between gap-2">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Production maintenant
        </span>
        <div class="flex flex-col items-end gap-0.5">
          <span
            class="text-[24px] leading-none font-semibold sm:text-[28px]"
            style="color: var(--color-solar); letter-spacing: -0.01em;"
          >
            {formatPower(production.productionNowW)}
          </span>
          <span class="text-[12px]" style="color: var(--color-muted-fg);">
            APS {formatPower(production.apsW)} · SolarBank {formatPower(production.sbW)}
          </span>
        </div>
      </div>

      <!-- Graphe mono-série : production RÉELLE (aire dégradée + repères/valeurs kW). -->
      {#if prodView}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative"
          style="height: 160px;"
          role="presentation"
          onmousemove={onProdMove}
          onmouseleave={() => (prodHover = null)}
        >
          <svg
            viewBox="0 0 240 120"
            class="block w-full"
            style="height: 160px;"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="prodGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style="stop-color: var(--color-solar); stop-opacity: 0.02;" />
                <stop offset="100%" style="stop-color: var(--color-solar); stop-opacity: 0.22;" />
              </linearGradient>
            </defs>

            <!-- Repères Y (horizontaux) -->
            {#each yTicks as g (g.kw)}
              <line
                x1="0"
                y1={g.y}
                x2="240"
                y2={g.y}
                stroke="var(--color-border)"
                stroke-width="1"
                opacity="0.6"
                vector-effect="non-scaling-stroke"
              />
            {/each}
            <!-- Repères X (verticaux, alignés sur les labels HH:MM) -->
            {#each gridX as gx (gx)}
              <line
                x1={gx}
                y1={TOP_Y}
                x2={gx}
                y2={BASE_Y}
                stroke="var(--color-border)"
                stroke-width="1"
                opacity="0.6"
                vector-effect="non-scaling-stroke"
              />
            {/each}

            <!-- Ligne de base -->
            <line
              x1="0"
              y1={BASE_Y}
              x2="240"
              y2={BASE_Y}
              stroke="var(--color-border)"
              stroke-width="0.5"
            />
            <!-- Aire (dégradé) + courbe -->
            <path d={prodArea} fill="url(#prodGrad)" />
            <path
              d={prodLine}
              fill="none"
              stroke="var(--color-solar)"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <!-- Valeurs kW (HTML net) alignées sur les repères Y -->
          <div class="pointer-events-none absolute inset-0">
            {#each yTicks as g (g.kw)}
              <span
                class="absolute left-0 rounded-sm px-1 text-[9px] leading-none"
                style="top: {g.topPct}%; transform: translateY(-50%); color: var(--color-muted-fg); background: color-mix(in oklab, var(--color-card) 70%, transparent);"
                >{g.label}</span
              >
            {/each}
          </div>
          <ChartHoverLayer
            show={!!prodHoverView}
            xPct={prodHoverView?.xPct ?? 0}
            yPct={prodHoverView?.yPct ?? 0}
            label={prodHoverView?.label ?? ''}
          />
        </div>
      {:else}
        <!-- État vide en HTML : le texte SVG se déformerait (preserveAspectRatio=none). -->
        <div
          class="flex items-center justify-center text-[12px]"
          style="height: 160px; color: var(--color-muted-fg);"
        >
          En attente de données…
        </div>
      {/if}

      <div class="flex justify-between text-[10px]" style="color: var(--color-muted-fg);">
        {#if prodView}
          {#each prodView.ticks as label, i (i)}
            <span>{label}</span>
          {/each}
        {/if}
      </div>

      <div
        class="flex flex-wrap items-center justify-between gap-3 text-[11px]"
        style="color: var(--color-muted-fg);"
      >
        <span class="inline-flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background: var(--color-solar);"></span>
          Production PV
        </span>
        {#if prodView}
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-1.5">
              <span class="text-[10px]">Lissage</span>
              <input
                type="range"
                min="0"
                max="7"
                step="1"
                value={preferences.productionSmoothHalf}
                oninput={(e) =>
                  preferences.setProductionSmoothHalf(
                    Number((e.currentTarget as HTMLInputElement).value)
                  )}
                class="h-1 w-20 cursor-pointer"
                style="accent-color: var(--color-primary);"
                aria-label="Lissage de la courbe de production"
              />
              <span class="text-[10px] tabular-nums" style="min-width: 3.4rem;">
                {preferences.productionSmoothHalf === 0
                  ? 'brut'
                  : `~${(2 * preferences.productionSmoothHalf + 1) * 2} min`}
              </span>
            </label>
            <span>pic {formatPower(prodKwMax * 1000)}</span>
          </div>
        {/if}
      </div>
    </section>

    <!-- ═══ Section 3 : Prévision PV — forecast-bridge ═══ -->
    <section
      class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="flex items-center justify-between">
        <div class="flex flex-col gap-0.5">
          <span class="text-[14px] font-semibold">Prévisions PV 48h</span>
          <span class="text-[11px]" style="color: var(--color-muted-fg);">
            {#if forecast.status === 'error'}
              Prévision indisponible
            {:else}
              Open-Meteo · AROME · sud + ouest
            {/if}
          </span>
        </div>
        <span
          class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em]"
          style="background: var(--color-solar-muted); color: var(--color-solar);"
        >
          +{forecast.next24hKwh.toFixed(1)} kWh / 24h
        </span>
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="relative"
        style="height: 140px;"
        role="presentation"
        onmousemove={onFcMove}
        onmouseleave={() => (fcHover = null)}
      >
        <svg
          viewBox="0 0 480 90"
          class="block w-full"
          style="height: 140px;"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="fcGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style="stop-color: var(--color-solar); stop-opacity: 0.02;" />
              <stop offset="100%" style="stop-color: var(--color-solar); stop-opacity: 0.18;" />
            </linearGradient>
          </defs>

          <!-- Repères Y / X (mêmes que la production) -->
          {#each fcTicks as g (g.kw)}
            <line
              x1="0"
              y1={g.y}
              x2="480"
              y2={g.y}
              stroke="var(--color-border)"
              stroke-width="1"
              opacity="0.6"
              vector-effect="non-scaling-stroke"
            />
          {/each}
          {#each fcGridX as gx (gx)}
            <line
              x1={gx}
              y1="6"
              x2={gx}
              y2="80"
              stroke="var(--color-border)"
              stroke-width="1"
              opacity="0.6"
              vector-effect="non-scaling-stroke"
            />
          {/each}

          <line x1="0" y1="80" x2="480" y2="80" stroke="var(--color-border)" stroke-width="0.5" />
          <!-- Aire dégradée sous Total (harmonisée avec la prod) -->
          <path d={pvArea()} fill="url(#fcGrad)" />
          <path
            d={pvLine('kwSud')}
            fill="none"
            stroke="var(--color-sud)"
            stroke-width="1"
            opacity="0.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <path
            d={pvLine('kwOuest')}
            fill="none"
            stroke="var(--color-ouest)"
            stroke-width="1"
            opacity="0.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <path
            d={pvLine('kw')}
            fill="none"
            stroke="var(--color-solar)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <!-- Valeurs kW (HTML net) alignées sur les repères Y -->
        <div class="pointer-events-none absolute inset-0">
          {#each fcTicks as g (g.kw)}
            <span
              class="absolute left-0 rounded-sm px-1 text-[9px] leading-none"
              style="top: {g.topPct}%; transform: translateY(-50%); color: var(--color-muted-fg); background: color-mix(in oklab, var(--color-card) 70%, transparent);"
              >{g.label}</span
            >
          {/each}
        </div>
        <ChartHoverLayer
          show={!!fcHoverView}
          xPct={fcHoverView?.xPct ?? 0}
          yPct={fcHoverView?.yPct ?? 0}
          label={fcHoverView?.label ?? ''}
        />
      </div>

      <div class="flex flex-wrap gap-3 text-[11px]" style="color: var(--color-muted-fg);">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background: var(--color-solar);"></span>
          Total
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background: var(--color-sud);"></span>
          Sud
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background: var(--color-ouest);"></span>
          Ouest
        </span>
      </div>

      <div class="flex justify-between text-[10px]" style="color: var(--color-muted-fg);">
        <span>Auj.</span>
        <span>12h</span>
        <span>Dem.</span>
        <span>12h</span>
        <span>+48h</span>
      </div>
    </section>
  </div>

  <!-- ═══ Section 2 : Conso électroménager (Frigo, Lave-linge…) ═══ -->
  {#if appliancePlugs.length > 0 || matterPlugs.length > 0}
    <section class="flex flex-col gap-3">
      <h2
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Conso électroménager · {appliancePlugs.length + matterPlugs.length}
      </h2>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {#each appliancePlugs as device (device.ieee)}
          <ApplianceCard {device} />
        {/each}
        {#each matterPlugs as p (p.nodeId)}
          <ApplianceCard name={p.name} power={p.powerW ?? 0} />
        {/each}
      </div>
    </section>
  {/if}

  <!-- ═══ Cumulus ECS — déplacé depuis /climat, sous l'électroménager ═══ -->
  <CumulusCard />

  <!-- ═══ Section 3 : Tableau mensuel ═══ -->
  <section class="overflow-x-auto">
    <table class="yeldra-table w-full text-[12px]">
      <thead>
        <tr>
          <th></th>
          {#each months as m, i (m)}
            <th class:active={i === currentMonthIdx} class:future={i > currentMonthIdx}>
              {m}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.label)}
          <tr>
            <td class="row-label">{row.label}</td>
            {#each row.values as v, i (i)}
              <td
                class:active={i === currentMonthIdx}
                class:future={i > currentMonthIdx}
                class="numeric"
              >
                {fmtCell(v, row.unit)}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <!-- ═══ Section 4 : KPIs humanisés ═══ -->
  <section>
    <h2
      class="mb-3 text-[14px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Impact ce mois ({months[currentMonthIdx]})
    </h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard
        label="CO₂ évité"
        value={co2Saved.toFixed(0)}
        unit="kg"
        trend={`${(co2Saved * 12).toFixed(0)} kg/an estimé`}
        domain="battery"
      />
      <KpiCard
        label="Équivalent VE"
        value={evKmEquiv.toFixed(0)}
        unit="km"
        trend="en voiture électrique"
        domain="solar"
      />
      <KpiCard
        label="Autosuffisance"
        value={autonomyPct.toString()}
        unit="%"
        trend="part autoconsommée"
        domain="hc"
      />
      <KpiCard
        label="ROI installation"
        value={roiYears > 0 ? roiYears.toString() : '✓'}
        unit={roiYears > 0 ? 'ans restants' : 'amorti'}
        trend={`amorti ${amortizedPct}% · ${Math.round(savedTotalEur)} € / ${Math.round(installEur)} €`}
        domain="consumption"
      />
    </div>
  </section>
</div>

<style>
  .yeldra-table {
    border-collapse: separate;
    border-spacing: 0;
    min-width: 720px;
  }
  .yeldra-table th,
  .yeldra-table td {
    padding: 8px 10px;
    text-align: center;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-muted-fg);
  }
  .yeldra-table th {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--color-muted);
  }
  .yeldra-table th:first-child,
  .yeldra-table td:first-child {
    text-align: left;
    background: transparent;
    border-right: 1px solid var(--color-border);
  }
  .yeldra-table td.row-label {
    color: var(--color-fg);
    font-weight: 500;
  }
  .yeldra-table td.numeric {
    font-variant-numeric: tabular-nums;
  }
  .yeldra-table th.active {
    background: var(--color-primary);
    color: var(--color-primary-fg);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }
  .yeldra-table td.active {
    background: var(--color-primary-muted);
    color: var(--color-primary);
    font-weight: 700;
  }
  .yeldra-table td.future,
  .yeldra-table th.future {
    opacity: 0.4;
  }
</style>
