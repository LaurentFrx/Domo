<script lang="ts">
  /**
   * Flow Diagram énergie — disposition radiale autour de la Maison.
   *
   * 100 % SVG : nœuds, icônes, textes et lignes sont tous dans le viewBox.
   * Alignement parfait quelle que soit la largeur du container (plus de
   * superposition HTML/SVG comme avant). Container max-w 520px centré.
   *
   * 4 nœuds périphériques : PV ↑, Batterie ←, Réseau →, Cumulus ↓
   * Lignes Bézier courbes, animation stroke-dashoffset CSS.
   */

  interface Props {
    pvPowerW: number;
    homePowerW: number;
    /** + charge, - décharge. */
    batteryNetW: number;
    /** 0-100. */
    batterySoc: number;
    /** + import, - export. */
    gridPowerW: number;
    cumulusTempC: number;
    cumulusPowerW: number;
    cumulusOn: boolean;
  }

  let {
    pvPowerW,
    homePowerW,
    batteryNetW,
    batterySoc,
    gridPowerW,
    cumulusTempC,
    cumulusPowerW,
    cumulusOn
  }: Props = $props();

  // Épaisseur de ligne 1.5px à 5px selon la puissance (W)
  function strokeForW(w: number): number {
    const abs = Math.abs(w);
    if (abs < 30) return 1.5;
    if (abs > 4000) return 5;
    return 1.5 + (abs / 4000) * 3.5;
  }

  /** Format Watts avec séparateur de milliers (espace insécable). */
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }

  // ─── Décisions de flux ─────────────────────────────────────────────────
  const pvToHomeActive = $derived(pvPowerW > 30);
  const pvToBatActive = $derived(pvPowerW > 30 && batteryNetW > 30);
  const batToHomeActive = $derived(batteryNetW < -30);
  const gridImportActive = $derived(gridPowerW > 30);
  const gridExportActive = $derived(gridPowerW < -30);
  const homeToCumActive = $derived(cumulusOn && cumulusPowerW > 30);

  const batteryLabel = $derived(
    batteryNetW > 30 ? 'Charge' : batteryNetW < -30 ? 'Décharge' : 'Repos'
  );

  const gridLabel = $derived(
    gridExportActive ? 'Injection' : gridImportActive ? 'Import' : 'Repos'
  );

  // Positions des nœuds dans le viewBox 400×400
  const N = {
    pv: { x: 200, y: 60 },
    bat: { x: 60, y: 200 },
    home: { x: 200, y: 200 },
    grid: { x: 340, y: 200 },
    cum: { x: 200, y: 340 }
  };

  const SOLAR = 'var(--color-solar)';
  const BAT = 'var(--color-battery)';
  const HOME = 'var(--color-consumption)';
  const GRID = 'var(--color-grid-energy)';
  const HC = 'var(--color-hc)';
</script>

<div class="mx-auto w-full" style="max-width: 520px;">
  <div
    class="relative rounded-[var(--radius-2xl)] border"
    style="background: var(--color-card); border-color: var(--color-border); aspect-ratio: 1;"
  >
    <svg
      viewBox="0 0 400 400"
      preserveAspectRatio="xMidYMid meet"
      class="absolute inset-0 h-full w-full"
      role="img"
      aria-label="Diagramme des flux d'énergie en watts"
    >
      <!-- ═══ Halo radial discret sous la maison ═══ -->
      <defs>
        <radialGradient id="house-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--color-primary)" stop-opacity="0.12" />
          <stop offset="60%" stop-color="var(--color-primary)" stop-opacity="0.04" />
          <stop offset="100%" stop-color="var(--color-primary)" stop-opacity="0" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="130" fill="url(#house-halo)" />

      <!-- ═══ Lignes (sous les nœuds) ═══════════════════════════════════ -->

      <!-- PV → Maison (vertical) -->
      <path
        class="flow-line"
        class:flow-active={pvToHomeActive}
        d="M 200 100 L 200 160"
        fill="none"
        stroke={SOLAR}
        stroke-width={pvToHomeActive ? strokeForW(pvPowerW) : 1}
        stroke-dasharray={pvToHomeActive ? '6 10' : '3 6'}
        stroke-linecap="round"
        opacity={pvToHomeActive ? 1 : 0.15}
      />

      <!-- PV → Batterie (Bezier) -->
      <path
        class="flow-line"
        class:flow-active={pvToBatActive}
        d="M 180 90 Q 120 130, 90 180"
        fill="none"
        stroke={BAT}
        stroke-width={pvToBatActive ? strokeForW(batteryNetW) : 1}
        stroke-dasharray={pvToBatActive ? '6 10' : '3 6'}
        stroke-linecap="round"
        opacity={pvToBatActive ? 1 : 0.15}
      />

      <!-- Batterie → Maison (Bezier, sens décharge) -->
      <path
        class="flow-line"
        class:flow-active={batToHomeActive}
        class:flow-reverse={batToHomeActive}
        d="M 160 200 L 100 200"
        fill="none"
        stroke={BAT}
        stroke-width={batToHomeActive ? strokeForW(-batteryNetW) : 1}
        stroke-dasharray={batToHomeActive ? '6 10' : '3 6'}
        stroke-linecap="round"
        opacity={batToHomeActive ? 1 : 0.15}
      />

      <!-- Réseau → Maison (sens import) -->
      <path
        class="flow-line"
        class:flow-active={gridImportActive}
        class:flow-reverse={gridImportActive}
        d="M 240 200 L 300 200"
        fill="none"
        stroke={GRID}
        stroke-width={gridImportActive ? strokeForW(gridPowerW) : 1}
        stroke-dasharray={gridImportActive ? '6 10' : '3 6'}
        stroke-linecap="round"
        opacity={gridImportActive ? 1 : 0.15}
      />

      <!-- Maison → Réseau (export) — superposée -->
      {#if gridExportActive}
        <path
          class="flow-line flow-active"
          d="M 240 200 L 300 200"
          fill="none"
          stroke={SOLAR}
          stroke-width={strokeForW(-gridPowerW)}
          stroke-dasharray="6 10"
          stroke-linecap="round"
          opacity="1"
        />
      {/if}

      <!-- Maison → Cumulus (vertical) -->
      <path
        class="flow-line"
        class:flow-active={homeToCumActive}
        d="M 200 240 L 200 300"
        fill="none"
        stroke={cumulusOn ? HC : GRID}
        stroke-width={homeToCumActive ? strokeForW(cumulusPowerW) : 1}
        stroke-dasharray={homeToCumActive ? '6 10' : '3 6'}
        stroke-linecap="round"
        opacity={homeToCumActive ? 1 : 0.15}
      />

      <!-- ═══ Nœud central : MAISON ═══════════════════════════════════ -->
      <g transform="translate(200 200)">
        <circle r="40" fill="var(--color-card)" stroke="var(--color-consumption)" stroke-width="1.5" opacity="0.5" />
        <circle r="36" fill="var(--color-consumption-muted)" stroke="var(--color-consumption)" stroke-width="1.5" />
        <g transform="translate(-12 -12)" stroke="var(--color-consumption)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 11L12 3l9 8v10H3z" />
          <path d="M9 21v-6h6v6" />
        </g>
        <text
          x="0"
          y="60"
          text-anchor="middle"
          fill="var(--color-consumption)"
          style="font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;"
        >{fmtW(homePowerW)}<tspan dx="2" style="font-size: 11px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan></text>
        <text
          x="0"
          y="76"
          text-anchor="middle"
          fill="var(--color-muted-fg)"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;"
        >Maison</text>
      </g>

      <!-- ═══ Nœud PV (haut) ═══════════════════════════════════════════ -->
      <g transform="translate({N.pv.x} {N.pv.y})">
        <circle r="30" fill="var(--color-solar-muted)" stroke={SOLAR} stroke-width="1.5" />
        <g stroke={SOLAR} stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="0" cy="0" r="6" />
          <path d="M0 -14V-11M0 11V14M-14 0H-11M11 0H14M-9.9 -9.9L-7.8 -7.8M7.8 7.8L9.9 9.9M-9.9 9.9L-7.8 7.8M7.8 -7.8L9.9 -9.9" />
        </g>
        <text
          x="0"
          y="-44"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >Solaire</text>
        <text
          x="0"
          y="50"
          text-anchor="middle"
          style="font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums;"
          fill={pvToHomeActive || pvToBatActive ? SOLAR : 'var(--color-muted-fg)'}
        >{fmtW(pvPowerW)}<tspan dx="2" style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan></text>
      </g>

      <!-- ═══ Nœud Batterie (gauche) ═══════════════════════════════════ -->
      <g transform="translate({N.bat.x} {N.bat.y})">
        <circle r="30" fill="var(--color-battery-muted)" stroke={BAT} stroke-width="1.5" />
        <g stroke={BAT} stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="-13" y="-7" width="22" height="14" rx="2" />
          <line x1="11" y1="-3" x2="11" y2="3" />
        </g>
        <!-- Remplissage SoC dynamique -->
        <rect
          x={-11}
          y={-5}
          width={Math.max(2, (batterySoc / 100) * 18)}
          height="10"
          rx="1"
          fill={BAT}
        />
        <text
          x="0"
          y="-44"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >{batteryLabel}</text>
        <text
          x="0"
          y="50"
          text-anchor="middle"
          fill={BAT}
          style="font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums;"
        >{batterySoc.toFixed(0)}<tspan dx="1" style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">%</tspan></text>
      </g>

      <!-- ═══ Nœud Réseau (droite) ═════════════════════════════════════ -->
      <g transform="translate({N.grid.x} {N.grid.y})">
        <circle r="30" fill="var(--color-grid-energy-muted)" stroke={GRID} stroke-width="1.5" />
        <g stroke={gridExportActive ? SOLAR : GRID} stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M0 -13V13M-8 -7L0 -13L8 -7M-7 0L0 -5L7 0M-6 6L0 2L6 6" />
        </g>
        <text
          x="0"
          y="-44"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >{gridLabel}</text>
        <text
          x="0"
          y="50"
          text-anchor="middle"
          style="font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums;"
          fill={gridExportActive ? SOLAR : gridImportActive ? GRID : 'var(--color-muted-fg)'}
        >{#if gridExportActive}↑ {:else if gridImportActive}↓ {/if}{fmtW(gridPowerW)}<tspan dx="2" style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan></text>
      </g>

      <!-- ═══ Nœud Cumulus (bas) ═══════════════════════════════════════ -->
      <g transform="translate({N.cum.x} {N.cum.y})">
        <circle r="30" fill="var(--color-hc-muted)" stroke={cumulusOn ? HC : 'var(--color-muted-fg)'} stroke-width="1.5" />
        <g stroke={cumulusOn ? HC : 'var(--color-muted-fg)'} stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M0 -13C0 -13 -4 -9 -4 -3C-4 1 -2 4 0 4C2 4 4 1 4 -3C4 -7 2 -9 2 -9C2 -7 1 -5 0 -5C-1 -5 0 -9 0 -13Z" />
          <path d="M-6 8C-6 4 -3 0 0 -2C0 0 2 2 2 4C4 5 6 7 6 10C6 13 4 14 0 14C-4 14 -6 13 -6 8Z" />
        </g>
        <text
          x="0"
          y="50"
          text-anchor="middle"
          style="font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums;"
          fill={cumulusOn ? HC : 'var(--color-muted-fg)'}
        >{cumulusTempC.toFixed(0)}<tspan dx="1" style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">°C</tspan></text>
        <text
          x="0"
          y="66"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; fill: var(--color-muted-fg);"
        >{cumulusOn ? `${fmtW(cumulusPowerW)} W` : 'Cumulus'}</text>
      </g>
    </svg>
  </div>
</div>

<style>
  .flow-line {
    transition:
      stroke-width 400ms var(--ease-out),
      opacity 400ms var(--ease-out);
  }
  .flow-active {
    animation: flow-forward 1.4s linear infinite;
  }
  .flow-reverse {
    animation: flow-reverse 1.4s linear infinite;
  }

  @keyframes flow-forward {
    to { stroke-dashoffset: -16; }
  }
  @keyframes flow-reverse {
    to { stroke-dashoffset: 16; }
  }

  @media (prefers-reduced-motion: reduce) {
    .flow-active,
    .flow-reverse {
      animation: none;
    }
  }
</style>
