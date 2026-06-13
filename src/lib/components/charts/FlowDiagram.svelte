<script lang="ts">
  /**
   * Flow Diagram énergie — SANKEY proportionnel (bilan de puissance instantané).
   *
   * Modèle quantitatif : la largeur de chaque bande est proportionnelle à la
   * puissance, et la conservation d'énergie est visible (hauteur totale des
   * APPORTS = hauteur totale des USAGES, des deux côtés de la barre centrale).
   *
   *   APPORTS                 USAGES
   *   ─────────               ──────────
   *   Solaire        ┐   ┌    Maison
   *   Batterie (déch)┤ ▮ ├    Batterie (charge)
   *   Réseau (import)┘   └    Réseau (injection)
   *
   * Bilan AC : PV + import + décharge = conso + charge + injection.
   * Le « home » fourni par la page vérifie home = pv + grid − batteryNet, donc
   * apports et usages s'équilibrent par construction.
   */

  interface Props {
    /** Apport solaire pan SUD (onduleur APS + SolarBank 1). W. */
    pvSudW: number;
    /** Apport solaire pan OUEST (SolarBank 2). W. */
    pvOuestW: number;
    homePowerW: number;
    /** Charge batterie (W) → côté USAGE. */
    batteryChargeW: number;
    /** Décharge batterie (W) → côté APPORT. (Les deux peuvent être non nuls.) */
    batteryDischargeW: number;
    /** 0-100. */
    batterySoc: number;
    /** + import, - export. */
    gridPowerW: number;
    /** Conso cumulus (W, mesure EM-50) — sous-conso de la Maison, affichée à part
     *  quand il chauffe. 0 ⇒ pas de nœud Cumulus (rendu inchangé). */
    cumulusW?: number;
  }

  // Le Sankey utilise les puissances du bilan AC (+ le SoC pour l'état repos).
  let {
    pvSudW,
    pvOuestW,
    homePowerW,
    batteryChargeW,
    batteryDischargeW,
    batterySoc,
    gridPowerW,
    cumulusW = 0
  }: Props = $props();

  /** Format Watts (séparateur de milliers, espace fine). */
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }

  // ─── Couleurs sémantiques ───────────────────────────────────────────────
  const SOLAR = 'var(--color-solar)';
  const SUD = 'var(--color-sud)';
  const OUEST = 'var(--color-ouest)';
  const BAT = 'var(--color-battery)';
  const HOME = 'var(--color-consumption)';
  const GRID = 'var(--color-grid-energy)';
  const CUMULUS = 'var(--color-hp)'; // chauffe-eau : teinte chaude, distincte de la Maison

  // ─── Géométrie du Sankey (viewBox 400 × 320) ────────────────────────────
  const VB_W = 400;
  const VB_H = 320;
  const CY = 168; // centre vertical (sous le bandeau d'en-tête)
  const H = 196; // hauteur de la barre centrale (pleine échelle)
  const GAP = 18; // écart vertical entre nœuds d'un même côté
  const CX = 200;
  const BUS_HALF = 6; // demi-largeur de la barre centrale
  const BAR_W = 7; // largeur des barres de nœud
  const X_LBAR = 132; // x de la barre des nœuds APPORT
  const X_RBAR = VB_W - X_LBAR - BAR_W; // symétrique → 261
  const BUS_L = CX - BUS_HALF; // 194
  const BUS_R = CX + BUS_HALF; // 206
  const BUS_TOP = CY - H / 2; // 70
  const MIN_BAND = 6; // hauteur mini d'une bande active (lisibilité)

  interface Item {
    key: string;
    name: string;
    sub?: string;
    color: string;
    w: number;
  }
  interface Link {
    key: string;
    color: string;
    ribbon: string;
    core: string;
    barX: number;
    barY: number;
    barH: number;
    labelX: number;
    labelY: number;
    anchor: 'start' | 'end';
    name: string;
    sub?: string;
    w: number;
  }

  /** Ribbon de Sankey (bande pleine) entre deux segments verticaux. */
  function ribbonPath(
    x0: number,
    y0t: number,
    y0b: number,
    x1: number,
    y1t: number,
    y1b: number
  ): string {
    const xc = (x0 + x1) / 2;
    return (
      `M ${x0} ${y0t} C ${xc} ${y0t}, ${xc} ${y1t}, ${x1} ${y1t} ` +
      `L ${x1} ${y1b} C ${xc} ${y1b}, ${xc} ${y0b}, ${x0} ${y0b} Z`
    );
  }

  /** Ligne médiane (pour le filet de flux animé). */
  function corePath(x0: number, c0: number, x1: number, c1: number): string {
    const xc = (x0 + x1) / 2;
    return `M ${x0} ${c0} C ${xc} ${c0}, ${xc} ${c1}, ${x1} ${c1}`;
  }

  /**
   * Construit les liens d'un côté.
   * side 'L' : barre des nœuds à gauche, ruban vers la barre centrale.
   * side 'R' : barre des nœuds à droite, ruban depuis la barre centrale.
   */
  function buildSide(items: Item[], side: 'L' | 'R', sideTotal: number): Link[] {
    if (!items.length || sideTotal <= 0) return [];
    const scale = H / sideTotal;
    // Hauteur de chaque bande (pleine échelle), avec mini de lisibilité.
    const heights = items.map((it) => Math.max(MIN_BAND, it.w * scale));
    // Les nœuds sont espacés (GAP) → ils « éventaillent » vers la barre.
    const groupH = heights.reduce((a, b) => a + b, 0) + (items.length - 1) * GAP;
    let nodeY = CY - groupH / 2;
    let busY = BUS_TOP;
    const out: Link[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const h = heights[i];
      const nTop = nodeY;
      const bTop = busY;
      let ribbon: string;
      let core: string;
      let barX: number;
      let labelX: number;
      let anchor: 'start' | 'end';
      if (side === 'L') {
        const barRight = X_LBAR + BAR_W;
        ribbon = ribbonPath(barRight, nTop, nTop + h, BUS_L, bTop, bTop + h);
        core = corePath(barRight, nTop + h / 2, BUS_L, bTop + h / 2);
        barX = X_LBAR;
        labelX = X_LBAR - 9;
        anchor = 'end';
      } else {
        ribbon = ribbonPath(BUS_R, bTop, bTop + h, X_RBAR, nTop, nTop + h);
        core = corePath(BUS_R, bTop + h / 2, X_RBAR, nTop + h / 2);
        barX = X_RBAR;
        labelX = X_RBAR + BAR_W + 9;
        anchor = 'start';
      }
      out.push({
        key: it.key,
        color: it.color,
        ribbon,
        core,
        barX,
        barY: nTop,
        barH: h,
        labelX,
        labelY: nTop + h / 2,
        anchor,
        name: it.name,
        sub: it.sub,
        w: it.w
      });
      nodeY += h + GAP;
      busY += h;
    }
    return out;
  }

  // ─── Décomposition apports / usages ─────────────────────────────────────
  const layout = $derived.by(() => {
    const sources: Item[] = [];
    // Solaire séparé par pan : Sud (APS + SB1) et Ouest (SB2).
    if (pvSudW > 1)
      sources.push({ key: 'sud', name: 'Sud', sub: 'solaire', color: SUD, w: pvSudW });
    if (pvOuestW > 1)
      sources.push({ key: 'ouest', name: 'Ouest', sub: 'solaire', color: OUEST, w: pvOuestW });
    if (batteryDischargeW > 1)
      sources.push({
        key: 'batd',
        name: 'Batterie',
        sub: 'décharge',
        color: BAT,
        w: batteryDischargeW
      });
    if (gridPowerW > 1)
      sources.push({ key: 'gridi', name: 'Réseau', sub: 'import', color: GRID, w: gridPowerW });

    const sinks: Item[] = [];
    // Cumulus (EM-50) = sous-conso de la Maison : on le SÉPARE visuellement quand
    // il chauffe (> 50 W), sans double-compter (Maison = home − cumulus). Le split
    // n'a lieu que si la Maison reste positive → sinon Maison entière (rendu
    // identique à l'absence de mesure, ex. cumulus à l'arrêt en été).
    const cumW = cumulusW > 50 ? cumulusW : 0;
    const homeRest = homePowerW - cumW;
    if (cumW > 0 && homeRest > 50) {
      sinks.push({ key: 'home', name: 'Maison', color: HOME, w: homeRest });
      sinks.push({ key: 'cumulus', name: 'Cumulus', sub: 'eau chaude', color: CUMULUS, w: cumW });
    } else if (homePowerW > 1) {
      sinks.push({ key: 'home', name: 'Maison', color: HOME, w: homePowerW });
    }
    if (batteryChargeW > 1)
      sinks.push({ key: 'batc', name: 'Batterie', sub: 'charge', color: BAT, w: batteryChargeW });
    if (gridPowerW < -1)
      sinks.push({ key: 'gride', name: 'Réseau', sub: 'injection', color: SOLAR, w: -gridPowerW });

    const totalS = sources.reduce((a, b) => a + b.w, 0);
    const totalK = sinks.reduce((a, b) => a + b.w, 0);
    const rest = Math.max(totalS, totalK) < 30;

    return {
      rest,
      total: Math.round((totalS + totalK) / 2),
      left: buildSide(sources, 'L', totalS),
      right: buildSide(sinks, 'R', totalK)
    };
  });

  // ─── prefers-reduced-motion ─────────────────────────────────────────────
  let reducedMotion = $state(false);
  $effect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = m.matches;
    const handler = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    m.addEventListener('change', handler);
    return () => m.removeEventListener('change', handler);
  });

  // ─── Résumé accessible ──────────────────────────────────────────────────
  const ariaLabel = $derived.by(() => {
    const f = (l: Link) => `${l.name}${l.sub ? ' ' + l.sub : ''} ${fmtW(l.w)} watts`;
    const apports = layout.left.map(f).join(', ') || 'aucun';
    const usages = layout.right.map(f).join(', ') || 'aucun';
    return `Bilan de puissance instantané. Apports : ${apports}. Usages : ${usages}.`;
  });
</script>

<div class="relative mx-auto w-full" style="max-width: 520px;">
  <div
    class="flow-card relative z-[1] overflow-hidden rounded-[var(--radius-3xl)] border"
    style="background: var(--color-card); aspect-ratio: {VB_W / VB_H};"
  >
    <!-- Lueurs vertes (image) DANS la carte → clipées par overflow-hidden, donc
         collées aux bords SANS déborder du cadre. -->
    <div class="flow-lueur flow-lueur-left" aria-hidden="true"></div>
    <div class="flow-lueur flow-lueur-right" aria-hidden="true"></div>
    <svg
      viewBox="0 0 {VB_W} {VB_H}"
      preserveAspectRatio="xMidYMid meet"
      class="absolute inset-0 h-full w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <!-- En-tête de colonnes -->
      <text
        x="20"
        y="34"
        style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >Apports</text
      >
      <text
        x={CX}
        y="34"
        text-anchor="middle"
        style="font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--color-muted-fg); opacity: 0.7;"
        >{layout.rest ? '—' : `${fmtW(layout.total)} W`}</text
      >
      <text
        x={VB_W - 20}
        y="34"
        text-anchor="end"
        style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >Usages</text
      >

      {#if layout.rest}
        <!-- Système au repos : pas de flux significatif -->
        <line
          x1="120"
          y1={CY}
          x2={VB_W - 120}
          y2={CY}
          stroke="var(--color-border-strong)"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray="1 8"
        />
        <text
          x={CX}
          y={CY + 26}
          text-anchor="middle"
          style="font-size: 13px; font-weight: 600; fill: var(--color-muted-fg);"
          >Système à l'équilibre</text
        >
      {:else}
        <!-- Barre centrale (busbar AC) -->
        <rect
          x={BUS_L}
          y={BUS_TOP}
          width={BUS_HALF * 2}
          height={H}
          rx={BUS_HALF}
          fill="var(--color-primary-muted)"
          stroke="var(--color-primary)"
          stroke-opacity="0.4"
          stroke-width="1"
        />

        <!-- Rubans proportionnels -->
        {#each [...layout.left, ...layout.right] as l (l.key)}
          <path d={l.ribbon} fill={l.color} fill-opacity="0.4" />
          {#if !reducedMotion}
            <path
              class="flow-core"
              d={l.core}
              fill="none"
              stroke={l.color}
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-dasharray="2 10"
              opacity="0.9"
            />
          {/if}
        {/each}

        <!-- Barres de nœud + libellés -->
        {#each [...layout.left, ...layout.right] as l (l.key + '-node')}
          <rect x={l.barX} y={l.barY} width={BAR_W} height={l.barH} rx="3" fill={l.color} />
          <text
            x={l.labelX}
            y={l.labelY - 3}
            text-anchor={l.anchor}
            style="font-size: 11px; font-weight: 600; fill: var(--color-fg);"
            >{l.name}{#if l.sub}<tspan
                style="font-size: 9.5px; font-weight: 500; fill: var(--color-muted-fg);"
              >
                · {l.sub}</tspan
              >{/if}</text
          >
          <text
            x={l.labelX}
            y={l.labelY + 12}
            text-anchor={l.anchor}
            style="font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; fill: {l.color};"
            >{fmtW(l.w)}<tspan
              dx="2"
              style="font-size: 9.5px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan
            ></text
          >
        {/each}
      {/if}
    </svg>
  </div>
</div>

<style>
  /* ─── Lueurs « OVNI » Yeldra : deux sources lumineuses latérales ───────── */
  /* Liseré vert électrique + bloom doux qui débordent du bord de la carte. */
  .flow-card {
    border-color: color-mix(in oklab, var(--color-glow) 30%, var(--color-border));
    /* Halos en tokens pré-calculés (--color-glow-a70/a60) : jamais de
       color-mix() dans une box-shadow via var() (piège Chrome). */
    box-shadow:
      0 0 0 1px var(--color-glow-a70),
      0 0 26px -6px var(--color-glow-a60),
      var(--shadow-md);
  }

  /* Lueur verte STATIQUE = image lueur-verte.webp (remplace le glow respirant). */
  .flow-lueur {
    position: absolute;
    top: 50%;
    width: 300px;
    height: 82%;
    transform: translateY(-50%);
    pointer-events: none;
    z-index: 0;
    /* cover + position gauche : pas de marge de letterbox, le cœur vert (bord
       gauche de l'image) est plaqué au bord du div. */
    background: url('/lueur-verte.webp') no-repeat left center / cover;
    opacity: 0.95;
  }
  /* Source plaquée au bord de la carte → la lueur colle au flanc. */
  .flow-lueur-left {
    left: 0;
    transform: translate(-3%, -50%);
  }
  .flow-lueur-right {
    right: 0;
    transform: translate(3%, -50%) scaleX(-1);
  }

  .flow-core {
    animation: flow-march 0.9s linear infinite;
  }
  @keyframes flow-march {
    to {
      stroke-dashoffset: -12;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flow-core {
      animation: none;
    }
  }
</style>
