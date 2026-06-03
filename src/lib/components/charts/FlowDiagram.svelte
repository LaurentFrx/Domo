<script lang="ts">
  /**
   * Flow Diagram énergie — hub-and-spoke autour de la Maison.
   *
   * 100 % SVG dans un viewBox 400×400 (alignement parfait quelle que soit la
   * largeur). Modèle : 4 rayons orthogonaux partant du hub central « Maison »
   * vers Solaire ↑, Batterie ←, Réseau →, Cumulus ↓.
   *
   * Le flux est matérialisé par des PARTICULES lumineuses (animateMotion) qui
   * circulent le long de chaque rayon actif, dans le sens réel de l'énergie :
   *   - Solaire → Maison (production)
   *   - Maison ⇄ Batterie (charge / décharge)
   *   - Réseau ⇄ Maison (import / injection)
   *   - Maison → Cumulus (chauffe)
   * Débit, taille et vitesse des particules ∝ puissance. Anneaux de jauge pour
   * le SoC batterie et la température cumulus. prefers-reduced-motion respecté.
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

  // ─── Helpers ────────────────────────────────────────────────────────────
  /** Format Watts avec séparateur de milliers (espace fine). */
  function fmtW(w: number): string {
    return Math.round(Math.abs(w)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }

  /** Épaisseur du rail actif (1.5 → 5px) selon la puissance. */
  function strokeForW(w: number): number {
    const abs = Math.abs(w);
    if (abs < 30) return 1.5;
    if (abs > 4000) return 5;
    return 1.5 + (abs / 4000) * 3.5;
  }

  /** Nombre de particules selon la puissance (densité de flux). */
  function particleCount(w: number): number {
    const abs = Math.abs(w);
    if (abs > 1800) return 4;
    if (abs > 600) return 3;
    return 2;
  }

  /** Durée d'un cycle (s) — plus de puissance = plus rapide. Quantifiée par
   *  paliers de 0.3s pour éviter que de micro-variations de puissance ne
   *  redémarrent l'animation SMIL à chaque tick. */
  function flowDur(w: number): number {
    const t = Math.min(1, Math.abs(w) / 3000);
    const raw = 2.5 - t * 1.6; // 2.5s (faible) → 0.9s (élevé)
    return Math.round(raw / 0.3) * 0.3;
  }

  /** Rayon de la particule selon la puissance. */
  function particleR(w: number): number {
    const abs = Math.abs(w);
    return abs > 1800 ? 4.2 : abs > 600 ? 3.5 : 2.8;
  }

  // ─── Décisions de flux ──────────────────────────────────────────────────
  const pvActive = $derived(pvPowerW > 30);
  const batCharge = $derived(batteryNetW > 30);
  const batDischarge = $derived(batteryNetW < -30);
  const batActive = $derived(batCharge || batDischarge);
  const gridImport = $derived(gridPowerW > 30);
  const gridExport = $derived(gridPowerW < -30);
  const gridActive = $derived(gridImport || gridExport);
  const cumActive = $derived(cumulusOn && cumulusPowerW > 30);

  const batteryLabel = $derived(batCharge ? 'Charge' : batDischarge ? 'Décharge' : 'Repos');
  const gridLabel = $derived(gridExport ? 'Injection' : gridImport ? 'Import' : 'Repos');

  // ─── Couleurs sémantiques ───────────────────────────────────────────────
  const SOLAR = 'var(--color-solar)';
  const BAT = 'var(--color-battery)';
  const HOME = 'var(--color-consumption)';
  const GRID = 'var(--color-grid-energy)';
  const HC = 'var(--color-hc)';

  const gridColor = $derived(gridExport ? SOLAR : GRID);
  const cumColor = $derived(cumulusOn ? HC : 'var(--color-muted-fg)');

  // ─── Jauges (anneaux, pathLength=100) ───────────────────────────────────
  const socPct = $derived(Math.max(0, Math.min(100, batterySoc)));
  // Température cumulus mappée sur 10–65 °C
  const tempPct = $derived(Math.max(0, Math.min(100, ((cumulusTempC - 10) / 55) * 100)));

  // ─── prefers-reduced-motion (client only) ───────────────────────────────
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
    const p: string[] = [];
    if (pvActive) p.push(`solaire ${fmtW(pvPowerW)} watts vers la maison`);
    if (batCharge) p.push(`batterie en charge ${fmtW(batteryNetW)} watts`);
    if (batDischarge) p.push(`batterie en décharge ${fmtW(batteryNetW)} watts`);
    if (gridImport) p.push(`import réseau ${fmtW(gridPowerW)} watts`);
    if (gridExport) p.push(`injection réseau ${fmtW(gridPowerW)} watts`);
    if (cumActive) p.push(`cumulus en chauffe ${fmtW(cumulusPowerW)} watts`);
    p.push(`batterie ${socPct.toFixed(0)} pour cent`);
    p.push(`maison ${fmtW(homePowerW)} watts`);
    return 'Flux d’énergie : ' + (p.length ? p.join(', ') : 'tout au repos');
  });

  // ─── Particules par rayon actif (rendu inline sous <svg>) ───────────────
  interface Particle {
    r: number;
    dur: number;
    begin: string;
  }
  interface Flow {
    id: string;
    pathId: string;
    color: string;
    /** true = la particule va vers la Maison (sens nœud → hub). */
    reverse: boolean;
    particles: Particle[];
  }

  function makeParticles(w: number): Particle[] {
    const n = particleCount(w);
    const dur = flowDur(w);
    const r = particleR(w);
    return Array.from({ length: n }, (_, i) => ({
      r,
      dur,
      begin: `${(-(i * dur) / n).toFixed(2)}s`
    }));
  }

  const flows = $derived.by(() => {
    const out: Flow[] = [];
    if (pvActive)
      out.push({
        id: 'pv',
        pathId: 'spk-pv',
        color: SOLAR,
        reverse: true,
        particles: makeParticles(pvPowerW)
      });
    if (batCharge)
      out.push({
        id: 'bat',
        pathId: 'spk-bat',
        color: BAT,
        reverse: false,
        particles: makeParticles(batteryNetW)
      });
    else if (batDischarge)
      out.push({
        id: 'bat',
        pathId: 'spk-bat',
        color: BAT,
        reverse: true,
        particles: makeParticles(batteryNetW)
      });
    if (gridImport)
      out.push({
        id: 'grid',
        pathId: 'spk-grid',
        color: GRID,
        reverse: true,
        particles: makeParticles(gridPowerW)
      });
    else if (gridExport)
      out.push({
        id: 'grid',
        pathId: 'spk-grid',
        color: SOLAR,
        reverse: false,
        particles: makeParticles(gridPowerW)
      });
    if (cumActive)
      out.push({
        id: 'cum',
        pathId: 'spk-cum',
        color: HC,
        reverse: false,
        particles: makeParticles(cumulusPowerW)
      });
    return out;
  });
</script>

<div class="mx-auto w-full" style="max-width: 520px;">
  <div
    class="relative overflow-hidden rounded-[var(--radius-3xl)] border"
    style="background: var(--color-card); border-color: var(--color-border); aspect-ratio: 1; box-shadow: var(--shadow-md);"
  >
    <svg
      viewBox="0 0 400 400"
      preserveAspectRatio="xMidYMid meet"
      class="absolute inset-0 h-full w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <!-- Glow doux des particules -->
        <filter id="flow-glow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <!-- Glow large des nœuds actifs / hub -->
        <filter id="node-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <!-- Cœur lumineux du hub -->
        <radialGradient id="core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--color-primary)" stop-opacity="0.16" />
          <stop offset="45%" stop-color="var(--color-primary)" stop-opacity="0.05" />
          <stop offset="100%" stop-color="var(--color-primary)" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="home-fill" cx="50%" cy="38%" r="65%">
          <stop offset="0%" stop-color="var(--color-card-hover)" />
          <stop offset="100%" stop-color="var(--color-card)" />
        </radialGradient>
      </defs>

      <!-- Cœur lumineux central -->
      <circle cx="200" cy="200" r="150" fill="url(#core)" />

      <!-- ═══ Rails (paths = à la fois visibles et supports de mouvement) ═══ -->
      <!-- Orientés Maison → nœud. Particules « reverse » = nœud → Maison.   -->

      <!-- Solaire (haut) -->
      <path
        id="spk-pv"
        d="M 200 156 L 200 96"
        fill="none"
        stroke={pvActive ? SOLAR : 'var(--color-border-strong)'}
        stroke-width={pvActive ? strokeForW(pvPowerW) : 1.5}
        stroke-linecap="round"
        stroke-dasharray={pvActive ? 'none' : '0.5 7'}
        opacity={pvActive ? 0.35 : 0.5}
      />
      <!-- Batterie (gauche) -->
      <path
        id="spk-bat"
        d="M 156 200 L 96 200"
        fill="none"
        stroke={batActive ? BAT : 'var(--color-border-strong)'}
        stroke-width={batActive ? strokeForW(batteryNetW) : 1.5}
        stroke-linecap="round"
        stroke-dasharray={batActive ? 'none' : '0.5 7'}
        opacity={batActive ? 0.35 : 0.5}
      />
      <!-- Réseau (droite) -->
      <path
        id="spk-grid"
        d="M 244 200 L 304 200"
        fill="none"
        stroke={gridActive ? gridColor : 'var(--color-border-strong)'}
        stroke-width={gridActive ? strokeForW(gridPowerW) : 1.5}
        stroke-linecap="round"
        stroke-dasharray={gridActive ? 'none' : '0.5 7'}
        opacity={gridActive ? 0.35 : 0.5}
      />
      <!-- Cumulus (bas) -->
      <path
        id="spk-cum"
        d="M 200 244 L 200 304"
        fill="none"
        stroke={cumActive ? HC : 'var(--color-border-strong)'}
        stroke-width={cumActive ? strokeForW(cumulusPowerW) : 1.5}
        stroke-linecap="round"
        stroke-dasharray={cumActive ? 'none' : '0.5 7'}
        opacity={cumActive ? 0.35 : 0.5}
      />

      <!-- ═══ Particules de flux (inline → namespace SVG garanti) ═════════ -->
      {#if !reducedMotion}
        {#each flows as f (f.id)}
          {#each f.particles as p, i (i)}
            <circle class="particle" r={p.r} fill={f.color} filter="url(#flow-glow)">
              <animateMotion
                dur="{p.dur}s"
                begin={p.begin}
                repeatCount="indefinite"
                calcMode="linear"
                keyPoints={f.reverse ? '1;0' : '0;1'}
                keyTimes="0;1"
              >
                <mpath href="#{f.pathId}" xlink:href="#{f.pathId}" />
              </animateMotion>
            </circle>
          {/each}
        {/each}
      {/if}

      <!-- ═══ Nœud Solaire (haut) ══════════════════════════════════════════ -->
      <g transform="translate(200 64)">
        {#if pvActive}
          <circle r="26" fill={SOLAR} opacity="0.25" filter="url(#node-glow)" />
        {/if}
        <circle r="30" fill="var(--color-solar-muted)" stroke={SOLAR} stroke-width="1.5" />
        <g
          stroke={SOLAR}
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="0" cy="0" r="6" />
          <path
            d="M0 -14V-11M0 11V14M-14 0H-11M11 0H14M-9.9 -9.9L-7.8 -7.8M7.8 7.8L9.9 9.9M-9.9 9.9L-7.8 7.8M7.8 -7.8L9.9 -9.9"
          />
        </g>
        <text
          x="0"
          y="-44"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--color-muted-fg);"
          >Solaire</text
        >
      </g>
      <text
        x="200"
        y="112"
        text-anchor="middle"
        style="font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;"
        fill={pvActive ? SOLAR : 'var(--color-muted-fg)'}
        >{fmtW(pvPowerW)}<tspan
          dx="2"
          style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan
        ></text
      >

      <!-- ═══ Nœud Batterie (gauche) ═══════════════════════════════════════ -->
      <g transform="translate(64 200)">
        {#if batActive}
          <circle r="26" fill={BAT} opacity="0.22" filter="url(#node-glow)" />
        {/if}
        <!-- Anneau SoC -->
        <circle r="35" fill="none" stroke="var(--color-border)" stroke-width="2.5" opacity="0.6" />
        <circle
          r="35"
          fill="none"
          stroke={BAT}
          stroke-width="2.5"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="{socPct} 100"
          transform="rotate(-90)"
        />
        <circle r="30" fill="var(--color-battery-muted)" stroke={BAT} stroke-width="1.5" />
        <g stroke={BAT} stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="-13" y="-7" width="22" height="14" rx="2" />
          <line x1="11" y1="-3" x2="11" y2="3" />
        </g>
        <rect
          x="-11"
          y="-5"
          width={Math.max(2, (socPct / 100) * 18)}
          height="10"
          rx="1"
          fill={BAT}
        />
        <text
          x="0"
          y="-46"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--color-muted-fg);"
          >{batteryLabel}</text
        >
        <text
          x="0"
          y="58"
          text-anchor="middle"
          fill={BAT}
          style="font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;"
          >{socPct.toFixed(0)}<tspan
            dx="1"
            style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">%</tspan
          ></text
        >
      </g>

      <!-- ═══ Nœud Réseau (droite) ═════════════════════════════════════════ -->
      <g transform="translate(336 200)">
        {#if gridActive}
          <circle r="26" fill={gridColor} opacity="0.22" filter="url(#node-glow)" />
        {/if}
        <circle
          r="30"
          fill="var(--color-grid-energy-muted)"
          stroke={gridActive ? gridColor : GRID}
          stroke-width="1.5"
        />
        <g
          stroke={gridActive ? gridColor : GRID}
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M0 -13V13M-8 -7L0 -13L8 -7M-7 0L0 -5L7 0M-6 6L0 2L6 6" />
        </g>
        <text
          x="0"
          y="-44"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--color-muted-fg);"
          >{gridLabel}</text
        >
        <text
          x="0"
          y="58"
          text-anchor="middle"
          style="font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;"
          fill={gridExport ? SOLAR : gridImport ? HOME : 'var(--color-muted-fg)'}
          >{#if gridExport}↑{:else if gridImport}↓{/if}{fmtW(gridPowerW)}<tspan
            dx="2"
            style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan
          ></text
        >
      </g>

      <!-- ═══ Nœud Cumulus (bas) ═══════════════════════════════════════════ -->
      <g transform="translate(200 336)">
        {#if cumActive}
          <circle r="26" fill={HC} opacity="0.22" filter="url(#node-glow)" />
        {/if}
        <!-- Anneau température -->
        <circle r="35" fill="none" stroke="var(--color-border)" stroke-width="2.5" opacity="0.6" />
        <circle
          r="35"
          fill="none"
          stroke={cumColor}
          stroke-width="2.5"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="{tempPct} 100"
          transform="rotate(-90)"
        />
        <circle r="30" fill="var(--color-hc-muted)" stroke={cumColor} stroke-width="1.5" />
        <g
          stroke={cumColor}
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M0 -13C0 -13 -4 -9 -4 -3C-4 1 -2 4 0 4C2 4 4 1 4 -3C4 -7 2 -9 2 -9C2 -7 1 -5 0 -5C-1 -5 0 -9 0 -13Z"
          />
          <path
            d="M-6 8C-6 4 -3 0 0 -2C0 0 2 2 2 4C4 5 6 7 6 10C6 13 4 14 0 14C-4 14 -6 13 -6 8Z"
          />
        </g>
        <text
          x="0"
          y="-46"
          text-anchor="middle"
          style="font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--color-muted-fg);"
          >{cumActive ? `${fmtW(cumulusPowerW)} W` : 'Cumulus'}</text
        >
        <text
          x="0"
          y="52"
          text-anchor="middle"
          style="font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums;"
          fill={cumulusOn ? HC : 'var(--color-muted-fg)'}
          >{cumulusTempC.toFixed(0)}<tspan
            dx="1"
            style="font-size: 10px; font-weight: 500; fill: var(--color-muted-fg);">°C</tspan
          ></text
        >
      </g>

      <!-- ═══ Hub central : MAISON ═════════════════════════════════════════ -->
      <g transform="translate(200 200)">
        <circle
          class="home-pulse"
          r="46"
          fill="none"
          stroke={HOME}
          stroke-width="1.5"
          opacity="0.5"
        />
        <circle r="46" fill="url(#home-fill)" stroke="var(--color-border)" stroke-width="1" />
        <circle r="42" fill="var(--color-consumption-muted)" stroke={HOME} stroke-width="1.5" />
        <g
          transform="translate(-11 -25) scale(0.95)"
          stroke={HOME}
          stroke-width="2"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3 11L12 3l9 8v10H3z" />
          <path d="M9 21v-6h6v6" />
        </g>
        <text
          x="0"
          y="14"
          text-anchor="middle"
          fill={HOME}
          style="font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em;"
          >{fmtW(homePowerW)}<tspan
            dx="2"
            style="font-size: 11px; font-weight: 500; fill: var(--color-muted-fg);">W</tspan
          ></text
        >
        <text
          x="0"
          y="30"
          text-anchor="middle"
          style="font-size: 9px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; fill: var(--color-muted-fg);"
          >Maison</text
        >
      </g>
    </svg>
  </div>
</div>

<style>
  .particle {
    pointer-events: none;
  }
  .home-pulse {
    transform-origin: center;
    transform-box: fill-box;
    animation: home-breathe 3.2s var(--ease-default) infinite;
  }
  @keyframes home-breathe {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.5;
    }
    50% {
      transform: scale(1.06);
      opacity: 0.12;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .home-pulse {
      animation: none;
    }
  }
</style>
