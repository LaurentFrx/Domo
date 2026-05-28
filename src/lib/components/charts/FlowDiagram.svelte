<script lang="ts">
  /**
   * Flow Diagram énergie — disposition radiale autour de la Maison.
   *
   * 4 nœuds périphériques (PV ↑, Batterie ←, Réseau →, Cumulus ↓) reliés
   * à la Maison centrale via des courbes de Bézier. Lignes animées via
   * stroke-dashoffset (CSS, GPU) avec direction du flux respectée.
   * Largeur de ligne proportionnelle à la puissance.
   *
   * Valeurs affichées en Watts (séparateur milliers fr).
   * Désactivé si prefers-reduced-motion.
   */

  interface Props {
    /** Production PV instantanée (W). */
    pvPowerW: number;
    /** Consommation maison instantanée (W). */
    homePowerW: number;
    /** Puissance batterie nette : + charge, - décharge (W). */
    batteryNetW: number;
    /** SoC batterie 0-100. */
    batterySoc: number;
    /** Puissance réseau : + import, - export (W). */
    gridPowerW: number;
    /** Température cumulus °C. */
    cumulusTempC: number;
    /** Puissance cumulus (W). */
    cumulusPowerW: number;
    /** Cumulus actif (relais ON) ? */
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
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
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

  // Couleurs sémantiques utilisées dans le SVG
  const SOLAR = 'var(--color-solar)';
  const BAT = 'var(--color-battery)';
  const HOME = 'var(--color-consumption)';
  const GRID = 'var(--color-grid-energy)';
  const HC = 'var(--color-hc)';
  const MUTED = 'var(--color-border-strong)';
</script>

<div
  class="flow-card relative w-full overflow-hidden rounded-[var(--radius-2xl)] border"
  style="background: var(--color-card); border-color: var(--color-border); height: 280px;"
>
  <!-- Halo radial discret sous la maison -->
  <div
    class="pointer-events-none absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-50"
    style="background: radial-gradient(circle, var(--color-primary-muted) 0%, transparent 65%);"
    aria-hidden="true"
  ></div>

  <svg
    viewBox="0 0 240 200"
    preserveAspectRatio="xMidYMid meet"
    class="absolute inset-0 h-full w-full"
    role="img"
    aria-label="Diagramme des flux d'énergie en watts"
  >
    <!-- ═══ Lignes (sous les nœuds) ═══════════════════════════════════ -->

    <!-- PV (120,30) → Maison (120,100). Verticale, dérivation gauche pour batterie. -->
    <path
      class="flow-line"
      class:flow-active={pvToHomeActive}
      d="M 120 42 Q 120 65, 120 88"
      fill="none"
      stroke={SOLAR}
      stroke-width={pvToHomeActive ? strokeForW(pvPowerW) : 1}
      stroke-dasharray={pvToHomeActive ? '4 8' : '2 4'}
      stroke-linecap="round"
      opacity={pvToHomeActive ? 1 : 0.18}
    />

    <!-- PV → Batterie : Bezier courbe -->
    <path
      class="flow-line"
      class:flow-active={pvToBatActive}
      d="M 110 38 Q 70 50, 48 92"
      fill="none"
      stroke={BAT}
      stroke-width={pvToBatActive ? strokeForW(batteryNetW) : 1}
      stroke-dasharray={pvToBatActive ? '4 8' : '2 4'}
      stroke-linecap="round"
      opacity={pvToBatActive ? 1 : 0.18}
    />

    <!-- Batterie (40,100) → Maison : Bezier (sens décharge) -->
    <path
      class="flow-line"
      class:flow-active={batToHomeActive}
      class:flow-reverse={batToHomeActive}
      d="M 104 100 Q 80 100, 56 100"
      fill="none"
      stroke={BAT}
      stroke-width={batToHomeActive ? strokeForW(-batteryNetW) : 1}
      stroke-dasharray={batToHomeActive ? '4 8' : '2 4'}
      stroke-linecap="round"
      opacity={batToHomeActive ? 1 : 0.18}
    />

    <!-- Réseau (200,100) → Maison : Bezier (sens import) -->
    <path
      class="flow-line"
      class:flow-active={gridImportActive}
      class:flow-reverse={gridImportActive}
      d="M 136 100 Q 160 100, 184 100"
      fill="none"
      stroke={GRID}
      stroke-width={gridImportActive ? strokeForW(gridPowerW) : 1}
      stroke-dasharray={gridImportActive ? '4 8' : '2 4'}
      stroke-linecap="round"
      opacity={gridImportActive ? 1 : 0.18}
    />

    <!-- Maison → Réseau (export) - même path mais sens normal -->
    {#if gridExportActive}
      <path
        class="flow-line flow-active"
        d="M 136 100 Q 160 100, 184 100"
        fill="none"
        stroke={SOLAR}
        stroke-width={strokeForW(-gridPowerW)}
        stroke-dasharray="4 8"
        stroke-linecap="round"
        opacity="1"
      />
    {/if}

    <!-- Maison (120,100) → Cumulus (120,170) : verticale descendante -->
    <path
      class="flow-line"
      class:flow-active={homeToCumActive}
      d="M 120 116 Q 120 138, 120 158"
      fill="none"
      stroke={cumulusOn ? HC : MUTED}
      stroke-width={homeToCumActive ? strokeForW(cumulusPowerW) : 1}
      stroke-dasharray={homeToCumActive ? '4 8' : '2 4'}
      stroke-linecap="round"
      opacity={homeToCumActive ? 1 : 0.18}
    />

    <!-- ═══ Nœud central : MAISON ═════════════════════════════════════ -->
    <g transform="translate(120 100)">
      <!-- Halo de fond -->
      <circle r="22" fill="var(--color-card)" stroke="var(--color-consumption)" stroke-width="1.5" opacity="0.4" />
      <circle r="20" fill="var(--color-consumption-muted)" />
      <!-- Icône maison -->
      <g transform="translate(-9 -9)" stroke={HOME} stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8L9 3l6 5v8H3z" />
        <path d="M7 16v-4h4v4" />
      </g>
    </g>
  </svg>

  <!-- ═══ HTML par-dessus le SVG : valeurs/labels ═══════════════════════ -->

  <!-- PV en haut -->
  <div class="node-html" style="left: 50%; top: 8px; transform: translateX(-50%);">
    <div class="node-circle" style="background: var(--color-solar-muted); color: var(--color-solar);">
      <!-- Soleil -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    </div>
  </div>
  <div class="node-label" style="left: 50%; top: 53px; transform: translateX(-50%); text-align: center;">
    <div class="node-value" style="color: {pvToHomeActive ? SOLAR : 'var(--color-muted-fg)'};">
      {fmtW(pvPowerW)} <span class="unit">W</span>
    </div>
    <div class="node-name">Solaire</div>
  </div>

  <!-- Batterie à gauche -->
  <div class="node-html" style="left: 12px; top: 50%; transform: translateY(-50%);">
    <div class="node-circle" style="background: var(--color-battery-muted); color: var(--color-battery);">
      <!-- Batterie pleine -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="8" width="15" height="10" rx="1.5" />
        <line x1="20" y1="11" x2="20" y2="15" />
        <rect x="5" y="10" width="{Math.max(2, batterySoc / 100 * 11)}" height="6" rx="0.5" fill="currentColor" stroke="none" />
      </svg>
    </div>
  </div>
  <div class="node-label" style="left: 55px; top: 50%; transform: translateY(-50%); text-align: left;">
    <div class="node-value" style="color: {BAT};">
      {batterySoc.toFixed(0)}<span class="unit">%</span>
    </div>
    <div class="node-name">{batteryLabel}</div>
  </div>

  <!-- Réseau à droite -->
  <div class="node-html" style="right: 12px; top: 50%; transform: translateY(-50%);">
    <div class="node-circle" style="background: var(--color-grid-energy-muted); color: var(--color-grid-energy);">
      <!-- Tour réseau -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2v20M5 8l7-6 7 6M7 14l5-4 5 4M9 20l3-3 3 3" />
      </svg>
    </div>
  </div>
  <div class="node-label" style="right: 55px; top: 50%; transform: translateY(-50%); text-align: right;">
    <div class="node-value" style="color: {gridExportActive ? SOLAR : gridImportActive ? GRID : 'var(--color-muted-fg)'};">
      {#if gridExportActive}
        <span class="arrow">↑</span>
      {:else if gridImportActive}
        <span class="arrow">↓</span>
      {/if}
      {fmtW(gridPowerW)} <span class="unit">W</span>
    </div>
    <div class="node-name">{gridExportActive ? 'Injection' : gridImportActive ? 'Import' : 'Repos'}</div>
  </div>

  <!-- Cumulus en bas -->
  <div class="node-html" style="left: 50%; bottom: 8px; transform: translateX(-50%);">
    <div
      class="node-circle"
      style="background: var(--color-hc-muted); color: {cumulusOn ? HC : 'var(--color-muted-fg)'};"
    >
      <!-- Flamme -->
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3c0 4-3 5-3 9a3 3 0 006 0c0-1-1-2-1-3 2 1 3 3 3 5a5 5 0 01-10 0c0-3 2-4 3-7 .5-1.5 1-2.5 2-4z" />
      </svg>
    </div>
  </div>
  <div class="node-label" style="left: 50%; bottom: 53px; transform: translateX(-50%); text-align: center;">
    <div class="node-value" style="color: {cumulusOn ? HC : 'var(--color-muted-fg)'};">
      {cumulusTempC.toFixed(0)}<span class="unit">°C</span>
    </div>
    <div class="node-name">
      {cumulusOn ? `${fmtW(cumulusPowerW)} W` : 'Cumulus'}
    </div>
  </div>
</div>

<style>
  .flow-card {
    /* léger over-glow violet pour donner du caractère */
    box-shadow:
      0 1px 2px oklch(0.145 0 0 / 0.03),
      0 0 0 1px var(--color-border);
  }

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
    to {
      stroke-dashoffset: -12;
    }
  }
  @keyframes flow-reverse {
    to {
      stroke-dashoffset: 12;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .flow-active,
    .flow-reverse {
      animation: none;
    }
  }

  .node-html {
    position: absolute;
    pointer-events: none;
  }

  .node-circle {
    width: 44px;
    height: 44px;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1.5px solid currentColor;
    background-clip: padding-box;
  }

  .node-label {
    position: absolute;
    line-height: 1.1;
    pointer-events: none;
  }

  .node-value {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .node-value .unit {
    font-size: 10px;
    font-weight: 500;
    opacity: 0.7;
    margin-left: 1px;
  }

  .node-value .arrow {
    font-weight: 700;
    margin-right: 1px;
  }

  .node-name {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-muted-fg);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 2px;
  }
</style>
