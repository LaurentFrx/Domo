<script module lang="ts">
  // id de gradient/filtre unique par instance (2 cadrans sur une page ne
  // doivent pas partager url(#id), sinon le 1er écrase le 2e).
  let __cdCounter = 0;
</script>

<script lang="ts">
  /**
   * ClimateDial — cadran « instrument » verre dépoli, LECTURE SEULE (aucun drag).
   *
   * 🔒 Le rendu de ce cadran est VERROUILLÉ via la carte Séjour (validée 2026-06-20) :
   * ne pas en modifier l'apparence sans demande EXPLICITE de Laurent. La carte Salle
   * de bain le réutilise — toute évolution doit préserver le rendu Séjour à l'identique.
   *
   * Grand chiffre central = TEMPÉRATURE ACTUELLE (mesure). L'arc bas-gauche
   * (60°→210°, sens horaire) matérialise la CONSIGNE, proportionnel à
   * (target−min)/(max−min). Palette cyan (froid) / ambre (chaud) voulue.
   * Halo (feGaussianBlur) UNIQUEMENT sur l'arc + lueur sur l'icône — jamais
   * autour d'autres éléments. Le réglage de la consigne se fait à l'extérieur
   * (boutons −/+ de la carte) ; ce composant ne fait qu'afficher.
   */
  interface Props {
    /** Mesure réelle → grand chiffre central. */
    value: number | null;
    /** Consigne → longueur de l'arc. */
    target: number;
    min?: number;
    max?: number;
    mode?: 'heating' | 'cooling' | 'off';
    unitLabel?: string;
    /** Alimentation de l'unité (off → grisé, pas de halo, « À l'arrêt »). */
    on?: boolean;
  }

  let {
    value,
    target,
    min = 16,
    max = 30,
    mode = 'off',
    unitLabel = '°C',
    on = false
  }: Props = $props();

  const uid = `cd${__cdCounter++}`;

  const active = $derived(on && (mode === 'heating' || mode === 'cooling'));
  const cooling = $derived(mode === 'cooling');

  // ─── Géométrie de l'arc (viewBox 190×190) ───────────────────────────────
  const CX = 95;
  const CY = 95;
  const R = 83;
  const A0 = 60; // départ (bas-droite)
  const SWEEP = 150; // → 210° (haut-gauche), sens horaire

  function pt(deg: number) {
    const r = (deg * Math.PI) / 180;
    return { x: CX + R * Math.cos(r), y: CY + R * Math.sin(r) };
  }

  const frac = $derived(Math.max(0, Math.min(1, (target - min) / (max - min))));
  const arcPath = $derived.by(() => {
    const a1 = A0 + frac * SWEEP;
    const p0 = pt(A0);
    const p1 = pt(a1);
    const large = a1 - A0 > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  });

  // ─── Mouchetures fixes (verre dépoli) ───────────────────────────────────
  const speckles = [
    { x: 70, y: 55, r: 1.1 },
    { x: 120, y: 70, r: 0.9 },
    { x: 95, y: 48, r: 0.8 },
    { x: 60, y: 100, r: 1.0 },
    { x: 135, y: 110, r: 0.9 },
    { x: 80, y: 130, r: 1.1 },
    { x: 115, y: 140, r: 0.8 },
    { x: 50, y: 80, r: 0.9 },
    { x: 140, y: 85, r: 1.0 }
  ];

  // ─── Formatage du grand chiffre ─────────────────────────────────────────
  const txt = $derived(value == null ? null : value.toFixed(1));
  const intPart = $derived(txt ? txt.split('.')[0] : '—');
  const decPart = $derived(txt && txt.includes('.') ? `.${txt.split('.')[1]}` : '');
</script>

<div
  class="cd-wrap"
  class:cd-off={!active}
  style="--cd-accent: {cooling ? '#6fe3ff' : '#ffce9a'}; --cd-glow: {cooling
    ? 'rgba(111,227,255,.45)'
    : 'rgba(255,206,154,.45)'};"
>
  <svg viewBox="0 0 190 190" class="cd-svg" aria-hidden="true">
    <defs>
      <radialGradient id="{uid}-disc" cx="50%" cy="40%" r="65%">
        <stop offset="0%" stop-color="#1b2740" />
        <stop offset="55%" stop-color="#0d1322" />
        <stop offset="100%" stop-color="#080c16" />
      </radialGradient>
      <linearGradient id="{uid}-arcCold" x1="0" y1="1" x2="0.85" y2="0.1">
        <stop offset="0%" stop-color="#1b86e0" />
        <stop offset="100%" stop-color="#8af2ff" />
      </linearGradient>
      <linearGradient id="{uid}-arcWarm" x1="0" y1="1" x2="0.85" y2="0.1">
        <stop offset="0%" stop-color="#d9741a" />
        <stop offset="100%" stop-color="#ffd27a" />
      </linearGradient>
      <radialGradient id="{uid}-glow">
        <stop offset="0%" stop-color="var(--cd-accent)" stop-opacity="0.24" />
        <stop offset="68%" stop-color="var(--cd-accent)" stop-opacity="0" />
      </radialGradient>
      <filter id="{uid}-ag" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="4" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>

    <!-- Anneau sombre extérieur -->
    <circle cx={CX} cy={CY} r={R} fill="none" stroke="#10151f" stroke-width="16" />
    <!-- Disque verre dépoli + filet de bord -->
    <circle cx={CX} cy={CY} r="73" fill="url(#{uid}-disc)" />
    <circle cx={CX} cy={CY} r="73" fill="none" stroke="rgba(120,170,255,.14)" stroke-width="1" />
    <!-- Lueur « lit-from-within » teintée du mode (rétablie) -->
    {#if active}
      <circle cx={CX} cy={CY} r="60" fill="url(#{uid}-glow)" />
    {/if}
    <!-- Mouchetures -->
    {#each speckles as s (s.x)}
      <circle cx={s.x} cy={s.y} r={s.r} fill="#9fc4ff" opacity="0.22" />
    {/each}

    <!-- Arc consigne (halo seulement ici) -->
    {#if active && frac > 0.001}
      <path
        d={arcPath}
        fill="none"
        stroke="url(#{uid}-{cooling ? 'arcCold' : 'arcWarm'})"
        stroke-width="10"
        stroke-linecap="round"
        filter="url(#{uid}-ag)"
      />
    {/if}
  </svg>

  <!-- Centre : icône mode + grand chiffre (mesure) + unité -->
  <div class="cd-center">
    <!-- Icône mode : flamme quand on chauffe (l'icône de froid est volontairement absente). -->
    {#if active && !cooling}
      <div class="cd-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <path
            d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
          />
        </svg>
      </div>
    {/if}
    {#if value != null}
      <div class="cd-cur">
        <span class="cd-int">{intPart}</span><span class="cd-dec">{decPart}</span>
      </div>
      <div class="cd-unit">{unitLabel}</div>
    {:else}
      <div class="cd-arret">—</div>
    {/if}
  </div>
</div>

<style>
  .cd-wrap {
    position: relative;
    width: 100%;
    max-width: 100px;
    aspect-ratio: 1;
    margin-inline: auto;
    container-type: size;
  }
  .cd-svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .cd-center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5cqw;
    pointer-events: none;
  }
  .cd-icon {
    color: var(--cd-accent);
    filter: drop-shadow(0 0 5px var(--cd-accent));
  }
  .cd-icon svg {
    width: 15cqw;
    height: 15cqw;
    display: block;
  }
  .cd-cur {
    display: flex;
    align-items: flex-start;
    line-height: 0.85;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: #eaf3ff;
    text-shadow: 0 0 18px var(--cd-glow);
  }
  .cd-int {
    font-size: 40cqw;
    font-weight: 300;
  }
  .cd-dec {
    font-size: 18cqw;
    font-weight: 300;
    margin-top: 0.5em;
    opacity: 0.72;
  }
  .cd-unit {
    font-size: 9cqw;
    font-weight: 400;
    letter-spacing: 0.06em;
    color: #9ec2d8;
  }
  .cd-arret {
    font-size: 11cqw;
    font-weight: 250;
    color: #74839c;
    letter-spacing: -0.01em;
  }

  /* OFF : disque grisé, aucune lueur — mais la température reste lisible */
  .cd-off .cd-svg {
    filter: saturate(0.55) brightness(0.82);
  }
  .cd-off .cd-cur {
    color: #c2d2e6;
    text-shadow: none;
  }
  .cd-off .cd-unit {
    color: #8094ad;
  }
</style>
