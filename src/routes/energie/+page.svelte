<script lang="ts">
  import { forecast } from '$stores/forecast.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { consoSeries24h, pvSeries24h, hourOfDay } from '$utils/mock-curves';
  import { onMount, onDestroy } from 'svelte';
  import KpiCard from '$components/cards/KpiCard.svelte';
  import ZigbeePlugTile from '$components/tiles/ZigbeePlugTile.svelte';

  onMount(() => {
    zigbee.connect();
    forecast.connect();
  });
  onDestroy(() => {
    zigbee.disconnect();
    forecast.disconnect();
  });

  // Prises Zigbee suivies pour la conso électroménager (Frigo, Lave-linge).
  const TRACKED_APPLIANCES = new Set(['frigo', 'lave-linge', 'lave_vaisselle']);
  const appliancePlugs = $derived(
    zigbee.devices.filter(
      (d) => d.category === 'plug' && TRACKED_APPLIANCES.has(d.friendlyName.toLowerCase())
    )
  );

  // ─── Section 1 : Stacked Area Chart 24h ─────────────────────────────
  const pvSeries = pvSeries24h(2.5);
  const consoSeries = consoSeries24h();
  const batteryCharge = pvSeries.map((p) => Math.max(0, p - 0.5) * 0.3);
  const gridImport = consoSeries.map((c, i) => Math.max(0, c - pvSeries[i] - batteryCharge[i]));

  function buildAreaPath(
    series: number[],
    scale: number,
    direction: 'up' | 'down',
    baseline = 60
  ): string {
    const w = series.length - 1 || 1;
    const points = series.map((v, i) => {
      const x = (i / w) * 240;
      const y = direction === 'up' ? baseline - v * scale : baseline + v * scale;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M0,${baseline} L${points.join(' L')} L240,${baseline} Z`;
  }

  const maxValue = Math.max(...pvSeries, ...consoSeries, 1.5);
  const yScale = 50 / maxValue;

  let selectedDay = $state(0);

  function changeDay(delta: number) {
    selectedDay = Math.max(-6, Math.min(0, selectedDay + delta));
  }

  // ─── Section 2 : Prévision PV 48h — forecast-bridge (Open-Meteo + PVLib) ──
  const fc = $derived(forecast.points.slice(0, 48));
  const maxKw = $derived(Math.max(...fc.map((p) => p.kw), 0.1));

  // Ligne simple déterministe (pas de bande P10/P90). Total = sud + ouest,
  // écrêté onduleur/SB ; le plan sud porte ~2× plus de Wc que l'ouest.
  function pvLine(prop: 'kw' | 'kwSud' | 'kwOuest'): string {
    const w = fc.length - 1 || 1;
    return fc
      .map((p, i) => {
        const x = (i / w) * 480;
        const y = 80 - (Math.max(0, p[prop]) / maxKw) * 70;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  // ─── Section 3 : Tableau mensuel ───────────────────────────────────
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
  const currentMonthIdx = new Date().getMonth();
  const rows: { label: string; values: number[]; unit: string }[] = [
    {
      label: 'Production PV',
      values: [85, 120, 210, 380, 520, 580, 595, 540, 410, 260, 150, 95],
      unit: 'kWh'
    },
    {
      label: 'Autoconsommation',
      values: [72, 98, 178, 312, 436, 478, 482, 442, 338, 215, 124, 82],
      unit: 'kWh'
    },
    {
      label: 'Surplus injecté',
      values: [13, 22, 32, 68, 84, 102, 113, 98, 72, 45, 26, 13],
      unit: 'kWh'
    },
    {
      label: 'Import réseau',
      values: [238, 192, 92, 0, 0, 0, 0, 0, 12, 84, 168, 224],
      unit: 'kWh'
    },
    { label: 'Économies', values: [16, 23, 41, 72, 101, 112, 115, 105, 78, 49, 28, 18], unit: '€' }
  ];

  // ─── Section 4 : KPIs humanisés ────────────────────────────────────
  const monthEconomy = rows[4].values[currentMonthIdx];
  const yearEconomy = rows[4].values.reduce((s, v) => s + v, 0);
  const co2Saved = rows[1].values[currentMonthIdx] * 0.05;
  const evKmEquiv = co2Saved * 6;
  const autonomyPct = Math.round(
    (rows[1].values[currentMonthIdx] /
      (rows[1].values[currentMonthIdx] + rows[3].values[currentMonthIdx])) *
      100
  );
  const roiYears = Math.round(8500 / Math.max(yearEconomy, 100));

  function fmtCell(v: number, unit: string): string {
    return unit === '€' ? `${v} €` : v.toString();
  }
</script>

<svelte:head>
  <title>Énergie — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Énergie</h1>
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      Sanguinet · Mai {new Date().getFullYear()}
    </span>
  </header>

  <!-- ═══ Section 1 : Stacked area 24h ═══ -->
  <section
    class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex items-center justify-between">
      <div class="flex flex-col gap-0.5">
        <span class="text-[14px] font-semibold">Flux d'énergie 24h</span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          {selectedDay === 0
            ? "Aujourd'hui"
            : selectedDay === -1
              ? 'Hier'
              : `Il y a ${-selectedDay} jours`}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={() => changeDay(-1)}
          class="flex h-7 w-7 items-center justify-center rounded-md border text-[14px] transition-colors"
          style="border-color: var(--color-border); color: var(--color-muted-fg);"
          aria-label="Jour précédent">‹</button
        >
        <button
          type="button"
          onclick={() => changeDay(1)}
          disabled={selectedDay === 0}
          class="flex h-7 w-7 items-center justify-center rounded-md border text-[14px] transition-colors disabled:opacity-40"
          style="border-color: var(--color-border); color: var(--color-muted-fg);"
          aria-label="Jour suivant">›</button
        >
      </div>
    </div>

    <svg viewBox="0 0 240 120" class="w-full" style="height: 160px;" preserveAspectRatio="none">
      <line x1="0" y1="60" x2="240" y2="60" stroke="var(--color-border)" stroke-width="0.5" />

      <path d={buildAreaPath(pvSeries, yScale, 'up')} fill="var(--color-solar)" opacity="0.22" />
      <path
        d={buildAreaPath(consoSeries, yScale, 'down')}
        fill="var(--color-consumption)"
        opacity="0.22"
      />

      <path
        d={pvSeries
          .map(
            (v, i) =>
              `${i === 0 ? 'M' : 'L'}${(i / (pvSeries.length - 1)) * 240},${60 - v * yScale}`
          )
          .join(' ')}
        fill="none"
        stroke="var(--color-solar)"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
      <path
        d={consoSeries
          .map(
            (v, i) =>
              `${i === 0 ? 'M' : 'L'}${(i / (consoSeries.length - 1)) * 240},${60 + v * yScale}`
          )
          .join(' ')}
        fill="none"
        stroke="var(--color-consumption)"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />

      <line
        x1={(hourOfDay() / 23) * 240}
        y1="0"
        x2={(hourOfDay() / 23) * 240}
        y2="120"
        stroke="var(--color-primary)"
        stroke-width="1"
        stroke-dasharray="2 2"
        vector-effect="non-scaling-stroke"
        opacity="0.5"
      />
    </svg>

    <div class="flex justify-between text-[10px]" style="color: var(--color-muted-fg);">
      <span>00h</span>
      <span>06h</span>
      <span>12h</span>
      <span>18h</span>
      <span>24h</span>
    </div>

    <div class="flex flex-wrap gap-3 text-[11px]" style="color: var(--color-muted-fg);">
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1 w-3 rounded-full" style="background: var(--color-solar);"></span>
        Production PV
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1 w-3 rounded-full" style="background: var(--color-consumption);"></span>
        Consommation
      </span>
    </div>
  </section>

  <!-- ═══ Section 2 : Conso électroménager (Frigo, Lave-linge…) ═══ -->
  {#if appliancePlugs.length > 0}
    <section class="flex flex-col gap-3">
      <h2
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Conso électroménager · {appliancePlugs.length}
      </h2>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {#each appliancePlugs as device (device.ieee)}
          <ZigbeePlugTile {device} />
        {/each}
      </div>
    </section>
  {/if}

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

    <svg viewBox="0 0 480 90" class="w-full" style="height: 140px;" preserveAspectRatio="none">
      <line x1="0" y1="80" x2="480" y2="80" stroke="var(--color-border)" stroke-width="0.5" />
      <path
        d={pvLine('kwSud')}
        fill="none"
        stroke="var(--color-sud)"
        stroke-width="1"
        opacity="0.75"
        vector-effect="non-scaling-stroke"
      />
      <path
        d={pvLine('kwOuest')}
        fill="none"
        stroke="var(--color-ouest)"
        stroke-width="1"
        opacity="0.75"
        vector-effect="non-scaling-stroke"
      />
      <path
        d={pvLine('kw')}
        fill="none"
        stroke="var(--color-solar)"
        stroke-width="1.75"
        vector-effect="non-scaling-stroke"
      />
    </svg>

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
                {v > 0 ? fmtCell(v, row.unit) : '—'}
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
        value={roiYears.toString()}
        unit="ans"
        trend="reste à amortir"
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
