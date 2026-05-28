<script lang="ts">
  /**
   * Flow Diagram énergie — SVG custom 5 nœuds.
   *
   * Disposition pentagone : PV en haut, Batterie à gauche, Maison au centre,
   * Réseau à droite, Cumulus en bas. Les lignes entre nœuds actifs sont
   * animées via stroke-dashoffset (CSS, GPU). Épaisseur proportionnelle à la
   * puissance. Désactivé si prefers-reduced-motion.
   *
   * Le flux passe TOUJOURS par la "Maison" (centre virtuel).
   */

  interface Props {
    /** Production PV instantanée (kW). */
    pvPowerKw: number;
    /** Consommation maison instantanée (kW). */
    homePowerKw: number;
    /** Puissance batterie nette : + charge, - décharge (kW). */
    batteryNetKw: number;
    /** SoC batterie 0-100. */
    batterySoc: number;
    /** Puissance réseau : + import, - export (kW). */
    gridPowerKw: number;
    /** Température cumulus °C. */
    cumulusTempC: number;
    /** Cumulus actif (relais ON) ? */
    cumulusOn: boolean;
  }

  let {
    pvPowerKw,
    homePowerKw,
    batteryNetKw,
    batterySoc,
    gridPowerKw,
    cumulusTempC,
    cumulusOn
  }: Props = $props();

  // Épaisseur de ligne 1.5px à 5px selon la puissance (kW)
  function strokeForKw(kw: number): number {
    const abs = Math.abs(kw);
    if (abs < 0.05) return 1.5;
    return Math.min(5, 1.5 + abs * 1.4);
  }

  // Positions des nœuds en % du viewBox 100×64
  const NODES = {
    pv: { x: 50, y: 8 },
    bat: { x: 14, y: 32 },
    home: { x: 50, y: 32 },
    grid: { x: 86, y: 32 },
    cum: { x: 50, y: 56 }
  };

  // ─── Décisions de flux ─────────────────────────────────────────────────
  const pvToHomeActive = $derived(pvPowerKw > 0.05);
  const pvToBatActive = $derived(pvPowerKw > 0.05 && batteryNetKw > 0.05);
  const batToHomeActive = $derived(batteryNetKw < -0.05);
  const gridImportActive = $derived(gridPowerKw > 0.05);
  const gridExportActive = $derived(gridPowerKw < -0.05);
  const homeToCumActive = $derived(cumulusOn);

  function fmtKw(kw: number, decimals = 2): string {
    return Math.abs(kw).toFixed(decimals);
  }
</script>

<div
  class="relative w-full overflow-hidden rounded-[var(--radius-2xl)] border"
  style="background: var(--color-card); border-color: var(--color-border); height: 240px;"
>
  <svg
    viewBox="0 0 100 64"
    preserveAspectRatio="xMidYMid meet"
    class="absolute inset-0 h-full w-full"
    role="img"
    aria-label="Diagramme des flux d'énergie"
  >
    <defs>
      <!-- Gradient pour ligne PV → Maison (sens du flux) -->
      <linearGradient id="flow-solar" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="var(--color-solar)" stop-opacity="1" />
        <stop offset="100%" stop-color="var(--color-solar)" stop-opacity="0.7" />
      </linearGradient>
    </defs>

    <!-- ─── Lignes (rendues en premier, sous les nœuds) ────────────── -->

    <!-- PV → Maison (toujours quand pv > 0) -->
    <line
      class="flow-line"
      class:flow-active={pvToHomeActive}
      x1={NODES.pv.x}
      y1={NODES.pv.y}
      x2={NODES.home.x}
      y2={NODES.home.y}
      stroke="var(--color-solar)"
      stroke-width={pvToHomeActive ? strokeForKw(pvPowerKw) : 0.8}
      stroke-dasharray={pvToHomeActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={pvToHomeActive ? 1 : 0.2}
    />

    <!-- PV → Batterie (charge) -->
    <line
      class="flow-line"
      class:flow-active={pvToBatActive}
      x1={NODES.pv.x}
      y1={NODES.pv.y}
      x2={NODES.bat.x}
      y2={NODES.bat.y}
      stroke="var(--color-battery)"
      stroke-width={pvToBatActive ? strokeForKw(batteryNetKw) : 0.8}
      stroke-dasharray={pvToBatActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={pvToBatActive ? 1 : 0.2}
    />

    <!-- Batterie → Maison (décharge) -->
    <line
      class="flow-line"
      class:flow-active={batToHomeActive}
      class:flow-reverse={batToHomeActive}
      x1={NODES.home.x}
      y1={NODES.home.y}
      x2={NODES.bat.x}
      y2={NODES.bat.y}
      stroke="var(--color-battery)"
      stroke-width={batToHomeActive ? strokeForKw(-batteryNetKw) : 0.8}
      stroke-dasharray={batToHomeActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={batToHomeActive ? 1 : 0.2}
    />

    <!-- Réseau → Maison (import) -->
    <line
      class="flow-line"
      class:flow-active={gridImportActive}
      class:flow-reverse={gridImportActive}
      x1={NODES.home.x}
      y1={NODES.home.y}
      x2={NODES.grid.x}
      y2={NODES.grid.y}
      stroke="var(--color-grid-energy)"
      stroke-width={gridImportActive ? strokeForKw(gridPowerKw) : 0.8}
      stroke-dasharray={gridImportActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={gridImportActive ? 1 : 0.2}
    />

    <!-- Maison → Réseau (export) -->
    <line
      class="flow-line"
      class:flow-active={gridExportActive}
      x1={NODES.home.x}
      y1={NODES.home.y}
      x2={NODES.grid.x}
      y2={NODES.grid.y}
      stroke="var(--color-solar)"
      stroke-width={gridExportActive ? strokeForKw(-gridPowerKw) : 0.8}
      stroke-dasharray={gridExportActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={gridExportActive ? 1 : 0.2}
    />

    <!-- Maison → Cumulus -->
    <line
      class="flow-line"
      class:flow-active={homeToCumActive}
      x1={NODES.home.x}
      y1={NODES.home.y}
      x2={NODES.cum.x}
      y2={NODES.cum.y}
      stroke={cumulusOn ? 'var(--color-hc)' : 'var(--color-grid-energy)'}
      stroke-width={cumulusOn ? 2.5 : 0.8}
      stroke-dasharray={homeToCumActive ? '2 3' : '1 2'}
      stroke-linecap="round"
      opacity={homeToCumActive ? 1 : 0.2}
    />
  </svg>

  <!-- ─── Nœuds en HTML absolu (par-dessus le SVG) ─────────────────── -->
  <div class="absolute inset-0 pointer-events-none">
    <!-- PV -->
    <div class="node" style="left: 50%; top: 8%; transform: translate(-50%, -50%);">
      <div class="node-icon" style="background: var(--color-solar-muted); color: var(--color-solar);">
        ☀
      </div>
      <div class="node-value" style="color: var(--color-solar);">
        {fmtKw(pvPowerKw)} <span class="node-unit">kW</span>
      </div>
      <div class="node-label">PV</div>
    </div>

    <!-- Batterie -->
    <div class="node" style="left: 14%; top: 50%; transform: translate(-50%, -50%);">
      <div class="node-icon" style="background: var(--color-battery-muted); color: var(--color-battery);">
        ⬢
      </div>
      <div class="node-value" style="color: var(--color-battery);">
        {batterySoc.toFixed(0)}<span class="node-unit">%</span>
      </div>
      <div class="node-label">
        {batteryNetKw > 0.05 ? 'Charge' : batteryNetKw < -0.05 ? 'Décharge' : 'Repos'}
      </div>
    </div>

    <!-- Maison -->
    <div class="node node-home" style="left: 50%; top: 50%; transform: translate(-50%, -50%);">
      <div class="node-icon" style="background: var(--color-consumption-muted); color: var(--color-consumption);">
        ⌂
      </div>
      <div class="node-value" style="color: var(--color-consumption);">
        {fmtKw(homePowerKw)} <span class="node-unit">kW</span>
      </div>
      <div class="node-label">Maison</div>
    </div>

    <!-- Réseau -->
    <div class="node" style="left: 86%; top: 50%; transform: translate(-50%, -50%);">
      <div class="node-icon" style="background: var(--color-grid-energy-muted); color: var(--color-grid-energy);">
        ⏚
      </div>
      <div class="node-value" style="color: {gridPowerKw < 0 ? 'var(--color-solar)' : 'var(--color-grid-energy)'};">
        {gridPowerKw < 0 ? '↑' : gridPowerKw > 0.05 ? '↓' : ''} {fmtKw(gridPowerKw)} <span class="node-unit">kW</span>
      </div>
      <div class="node-label">Réseau</div>
    </div>

    <!-- Cumulus -->
    <div class="node" style="left: 50%; top: 92%; transform: translate(-50%, -50%);">
      <div class="node-icon" style="background: var(--color-hc-muted); color: {cumulusOn ? 'var(--color-hc)' : 'var(--color-muted-fg)'};">
        ✦
      </div>
      <div class="node-value" style="color: {cumulusOn ? 'var(--color-hc)' : 'var(--color-muted-fg)'};">
        {cumulusTempC.toFixed(0)}<span class="node-unit">°C</span>
      </div>
      <div class="node-label">Cumulus</div>
    </div>
  </div>
</div>

<style>
  .flow-line {
    transition: stroke-width 300ms var(--ease-default), opacity 300ms var(--ease-default);
  }
  .flow-active {
    animation: flow-forward 1.5s linear infinite;
  }
  .flow-reverse {
    animation: flow-reverse 1.5s linear infinite;
  }

  @keyframes flow-forward {
    to {
      stroke-dashoffset: -10;
    }
  }
  @keyframes flow-reverse {
    to {
      stroke-dashoffset: 10;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .flow-active,
    .flow-reverse {
      animation: none;
    }
  }

  .node {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .node-icon {
    width: 28px;
    height: 28px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
  }

  .node-home .node-icon {
    width: 36px;
    height: 36px;
    font-size: 18px;
  }

  .node-value {
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .node-unit {
    font-size: 10px;
    font-weight: 500;
    opacity: 0.7;
  }

  .node-label {
    font-size: 10px;
    font-weight: 500;
    color: var(--color-muted-fg);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
</style>
