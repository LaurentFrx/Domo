<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import { anker } from '$stores/anker.svelte';
  import { formatDate } from '$utils/format';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';

  const date = $derived(formatDate());

  // ─── Heure courante (mise à jour pour le badge HC/HP) ───────────────────
  let now = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  const hour = $derived(now.getHours());
  const isHC = $derived(hour >= 22 || hour < 6);

  const TARIF_HC = 0.1812;
  const TARIF_HP = 0.2318;

  // ─── Flux énergétiques ─────────────────────────────────────────────────
  // Source : anker en priorité (valeurs réelles), sinon dashboard mock.
  const live = $derived(anker.connected);
  const pvKw = $derived(live ? anker.solarPowerW / 1000 : dashboard.solarPower);
  const gridKw = $derived(live ? anker.gridPowerW / 1000 : 0);
  const batteryKw = $derived(
    live
      ? anker.netBatteryPowerW / 1000
      : dashboard.batteryStatus === 'charge'
        ? 0.6
        : dashboard.batteryStatus === 'discharge'
          ? -0.4
          : 0
  );
  // Conso maison reconstituée : production - injection + soutirage - charge bat
  const houseKw = $derived(
    live
      ? Math.max(0, pvKw - Math.max(0, -gridKw) + Math.max(0, gridKw) - Math.max(0, batteryKw))
      : Math.max(0.4, (pvKw * dashboard.solarSelfConsumption) / 100 + 0.6)
  );
  // En mock, recalcul du grid à partir de house/pv/battery.
  const effectiveGridKw = $derived(live ? gridKw : houseKw + Math.max(0, batteryKw) - pvKw);

  // ─── Résumé journée ────────────────────────────────────────────────────
  const prodTotal = $derived(live ? anker.dailyProductionWh / 1000 : dashboard.solarTotal24h);
  const autoConso = $derived(
    live && anker.selfConsumptionRate !== null
      ? anker.selfConsumptionRate
      : dashboard.solarSelfConsumption
  );
  const economy = $derived(prodTotal * 0.18); // €
  const co2Saved = $derived(prodTotal * 0.06); // kg

  // ─── Courbe 24h prod + conso (mock cohérent) ────────────────────────────
  function genCurves() {
    const points = 24;
    const prod: number[] = [];
    const conso: number[] = [];
    for (let i = 0; i < points; i++) {
      const t = i / (points - 1);
      const sun = Math.max(0, Math.sin(Math.PI * t)) ** 1.2;
      prod.push(sun * 4.0);
      const base = 1.0 + 0.3 * Math.sin(t * Math.PI * 2 + Math.PI / 3);
      const cookingSpike = i === 12 || i === 19 ? 1.5 : 0;
      conso.push(base + cookingSpike);
    }
    return { prod, conso };
  }

  const curves = genCurves();

  const chartWidth = 320;
  const chartHeight = 96;
  const padX = 4;
  const padY = 6;

  function buildPath(data: number[], maxVal: number): string {
    const max = Math.max(maxVal, ...data, 0.001);
    const n = data.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = padX + (i * (chartWidth - padX * 2)) / Math.max(1, n - 1);
      const y = padY + (1 - data[i] / max) * (chartHeight - padY * 2);
      d += `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d.trim();
  }

  function buildArea(data: number[], maxVal: number): string {
    const stroke = buildPath(data, maxVal);
    return `${stroke} L ${chartWidth - padX} ${chartHeight} L ${padX} ${chartHeight} Z`;
  }

  const maxValChart = $derived(Math.max(...curves.prod, ...curves.conso));
  const prodStroke = $derived(buildPath(curves.prod, maxValChart));
  const consoStroke = $derived(buildPath(curves.conso, maxValChart));
  const prodArea = $derived(buildArea(curves.prod, maxValChart));
  const consoArea = $derived(buildArea(curves.conso, maxValChart));

  // ─── Largeur de flèche proportionnelle à la puissance ───────────────────
  function arrowW(kw: number): number {
    return Math.max(1.5, Math.min(5, Math.abs(kw) * 1.8));
  }

  const pvToHouseW = $derived(arrowW(Math.min(pvKw, houseKw)));
  const gridArrowW = $derived(arrowW(effectiveGridKw));
  const batteryArrowW = $derived(arrowW(batteryKw));
</script>

<svelte:head>
  <title>Énergie — Domo</title>
</svelte:head>

<div class="stagger-enter flex flex-col gap-2 md:gap-3">
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <div class="flex items-center justify-between gap-3">
      <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
      <div
        class="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-semibold tracking-wider"
        style:color={isHC ? 'var(--primary-400)' : 'var(--warning)'}
        style:background-color={isHC ? 'rgba(110,69,255,0.15)' : 'rgba(255,184,77,0.12)'}
      >
        {isHC ? 'HC' : 'HP'} · {(isHC ? TARIF_HC : TARIF_HP).toFixed(4)} €/kWh
      </div>
    </div>
    <div class="flex items-center gap-2">
      <h1 class="text-2xl font-medium text-white">Énergie</h1>
      <span
        class="rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wider"
        style:color={live ? 'var(--surface-base)' : 'var(--primary-400)'}
        style:background-color={live ? 'var(--accent-500)' : 'rgba(110,69,255,0.15)'}
      >
        {live ? 'LIVE' : 'DÉMO'}
      </span>
    </div>
  </header>

  <div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
    <!-- Flux temps réel -->
    <section
      class="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
    >
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
        FLUX EN TEMPS RÉEL
      </span>

      <svg viewBox="0 0 280 220" class="w-full" style="height: auto;">
        <defs>
          <marker
            id="arr-accent"
            viewBox="0 0 8 8"
            refX="4"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent-500)" />
          </marker>
          <marker
            id="arr-primary"
            viewBox="0 0 8 8"
            refX="4"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--primary-400)" />
          </marker>
          <marker
            id="arr-warn"
            viewBox="0 0 8 8"
            refX="4"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--warning)" />
          </marker>
        </defs>

        <!-- Soleil -->
        <g transform="translate(40,40)">
          <circle
            r="22"
            fill="rgba(61,253,152,0.12)"
            stroke="var(--accent-500)"
            stroke-width="1.5"
          />
          <circle r="9" fill="var(--accent-500)" />
          <text y="40" text-anchor="middle" fill="white" font-size="10" font-weight="500">PV</text>
          <text
            y="52"
            text-anchor="middle"
            fill="var(--accent-500)"
            font-size="11"
            font-weight="600"
          >
            {pvKw.toFixed(2)} kW
          </text>
        </g>

        <!-- Réseau -->
        <g transform="translate(240,40)">
          <rect
            x="-22"
            y="-18"
            width="44"
            height="36"
            rx="4"
            fill="rgba(255,184,77,0.1)"
            stroke="var(--warning)"
            stroke-width="1.5"
          />
          <path
            d="M-10,-8 L0,8 L-2,2 L8,-8"
            stroke="var(--warning)"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <text y="40" text-anchor="middle" fill="white" font-size="10" font-weight="500"
            >Réseau</text
          >
          <text y="52" text-anchor="middle" fill="var(--warning)" font-size="11" font-weight="600">
            {effectiveGridKw >= 0 ? '+' : ''}{effectiveGridKw.toFixed(2)} kW
          </text>
        </g>

        <!-- Maison -->
        <g transform="translate(140,110)">
          <circle
            r="28"
            fill="rgba(110,69,255,0.12)"
            stroke="var(--primary-400)"
            stroke-width="1.5"
          />
          <path
            d="M-12,2 L0,-12 L12,2 V10 H-12 Z"
            stroke="var(--primary-400)"
            stroke-width="1.5"
            fill="none"
            stroke-linejoin="round"
          />
          <text y="48" text-anchor="middle" fill="white" font-size="10" font-weight="500"
            >Maison</text
          >
          <text
            y="60"
            text-anchor="middle"
            fill="var(--primary-400)"
            font-size="11"
            font-weight="600"
          >
            {houseKw.toFixed(2)} kW
          </text>
        </g>

        <!-- Batterie -->
        <g transform="translate(140,180)">
          <rect
            x="-18"
            y="-10"
            width="36"
            height="20"
            rx="3"
            fill="rgba(61,253,152,0.06)"
            stroke="var(--accent-500)"
            stroke-width="1.2"
          />
          <rect x="18" y="-4" width="3" height="8" rx="1" fill="var(--accent-500)" />
          <rect
            x="-16"
            y="-8"
            width="28"
            height="16"
            rx="1.5"
            fill="var(--accent-500)"
            fill-opacity={dashboard.batteryLevel / 100}
          />
          <text y="26" text-anchor="middle" fill="white" font-size="10" font-weight="500">
            Batterie {Math.round(dashboard.batteryLevel)}%
          </text>
        </g>

        <!-- Flux PV → Maison -->
        <path
          d="M 64 50 Q 100 80 116 102"
          fill="none"
          stroke="var(--accent-500)"
          stroke-width={pvToHouseW}
          stroke-linecap="round"
          marker-end="url(#arr-accent)"
          opacity="0.9"
        />

        <!-- Flux Maison ↔ Réseau -->
        {#if effectiveGridKw > 0.05}
          <path
            d="M 216 50 Q 180 80 164 102"
            fill="none"
            stroke="var(--warning)"
            stroke-width={gridArrowW}
            stroke-linecap="round"
            marker-end="url(#arr-warn)"
            opacity="0.9"
          />
        {:else if effectiveGridKw < -0.05}
          <path
            d="M 164 102 Q 180 80 216 50"
            fill="none"
            stroke="var(--accent-500)"
            stroke-width={gridArrowW}
            stroke-linecap="round"
            marker-end="url(#arr-accent)"
            opacity="0.9"
          />
        {/if}

        <!-- Flux Maison ↔ Batterie -->
        {#if batteryKw > 0.05}
          <line
            x1="140"
            y1="140"
            x2="140"
            y2="168"
            stroke="var(--accent-500)"
            stroke-width={batteryArrowW}
            stroke-linecap="round"
            marker-end="url(#arr-accent)"
            opacity="0.9"
          />
        {:else if batteryKw < -0.05}
          <line
            x1="140"
            y1="168"
            x2="140"
            y2="140"
            stroke="var(--primary-400)"
            stroke-width={batteryArrowW}
            stroke-linecap="round"
            marker-end="url(#arr-primary)"
            opacity="0.9"
          />
        {/if}
      </svg>
    </section>

    <!-- Résumé journée : 4 mini-cards -->
    <section class="grid grid-cols-2 gap-2">
      <div
        class="tile-press flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:rounded-2xl md:p-3"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
            >PRODUCTION</span
          >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-500)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5l1.5 1.5 M5 19l1.5-1.5 M17.5 6.5l1.5-1.5"
            />
          </svg>
        </div>
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={prodTotal}
            decimals={1}
            class="text-xl font-medium text-[var(--accent-500)] tabular-nums md:text-2xl"
          />
          <span class="text-[10px] text-[var(--text-secondary)] md:text-xs">kWh</span>
        </div>
        <span class="text-[9px] text-[var(--text-tertiary)]">Aujourd'hui</span>
      </div>

      <div
        class="tile-press flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:rounded-2xl md:p-3"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
            >AUTOCONSO</span
          >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-500)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12 L12 3 L21 12 V20 H3 Z" />
            <path d="M9 20v-6h6v6" />
          </svg>
        </div>
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={autoConso}
            decimals={0}
            class="text-xl font-medium text-[var(--accent-500)] tabular-nums md:text-2xl"
          />
          <span class="text-[10px] text-[var(--text-secondary)] md:text-xs">%</span>
        </div>
        <span class="text-[9px] text-[var(--text-tertiary)]">Conso couverte</span>
      </div>

      <div
        class="tile-press flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:rounded-2xl md:p-3"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
            >ÉCONOMIES</span
          >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-500)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 4h11a4 4 0 0 1 0 8H8 M5 12h11a4 4 0 0 1 0 8H5 M3 7h6 M3 17h6" />
          </svg>
        </div>
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={economy}
            decimals={2}
            class="text-xl font-medium text-[var(--accent-500)] tabular-nums md:text-2xl"
          />
          <span class="text-[10px] text-[var(--text-secondary)] md:text-xs">€</span>
        </div>
        <span class="text-[9px] text-[var(--text-tertiary)]">Estimé</span>
      </div>

      <div
        class="tile-press flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:rounded-2xl md:p-3"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
            >CO₂ ÉVITÉ</span
          >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent-500)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3 C 7 8, 4 14, 8 19 C 14 21, 19 17, 20 11 C 17 9, 14 7, 12 3 Z" />
            <path d="M8 19 L 15 11" />
          </svg>
        </div>
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={co2Saved}
            decimals={2}
            class="text-xl font-medium text-[var(--accent-500)] tabular-nums md:text-2xl"
          />
          <span class="text-[10px] text-[var(--text-secondary)] md:text-xs">kg</span>
        </div>
        <span class="text-[9px] text-[var(--text-tertiary)]">≈ 0.06 kg/kWh</span>
      </div>
    </section>
  </div>

  <!-- Courbe production / consommation 24h -->
  <section
    class="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
  >
    <div class="flex items-center justify-between">
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
        PRODUCTION & CONSOMMATION — 24H
      </span>
      <div class="flex gap-3 text-[10px]">
        <div class="flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background-color: var(--accent-500);"></span>
          <span class="text-[var(--text-secondary)]">Production</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="h-1 w-3 rounded-full" style="background-color: var(--primary-400);"></span>
          <span class="text-[var(--text-secondary)]">Consommation</span>
        </div>
      </div>
    </div>

    <svg
      viewBox="0 0 {chartWidth} {chartHeight}"
      preserveAspectRatio="none"
      class="energie-chart w-full"
      style="height: {chartHeight}px;"
    >
      <defs>
        <linearGradient id="grad-prod" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent-500)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--accent-500)" stop-opacity="0.02" />
        </linearGradient>
        <linearGradient id="grad-conso" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--primary-400)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--primary-400)" stop-opacity="0.02" />
        </linearGradient>
      </defs>

      <path d={prodArea} fill="url(#grad-prod)" />
      <path d={consoArea} fill="url(#grad-conso)" />
      <path
        d={prodStroke}
        fill="none"
        stroke="var(--accent-500)"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d={consoStroke}
        fill="none"
        stroke="var(--primary-400)"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray="3 2"
      />
    </svg>

    <div class="flex justify-between text-[9px] text-[var(--text-secondary)]">
      <span>00h</span>
      <span>06h</span>
      <span>12h</span>
      <span>18h</span>
      <span>24h</span>
    </div>
  </section>
</div>

<style>
  @keyframes energie-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .energie-chart {
    animation: energie-fade-in 0.7s ease-out;
  }
</style>
