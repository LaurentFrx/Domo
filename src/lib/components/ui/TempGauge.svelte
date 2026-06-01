<script module lang="ts">
  // Compteur module → id de gradient unique par instance (sinon 2 jauges
  // sur la même page partagent le même url(#id) et la 1re écrase la 2e).
  let __tgCounter = 0;
</script>

<script lang="ts">
  /**
   * Gauge circulaire de consigne (Yeldra) — arc 270° (SW → SE).
   *
   * Design : instrument premium « lit-from-within ».
   *   - fill dégradé vertical (chauffe vers le haut) + glow,
   *   - anneau de ticks gradués actif/inactif (style Tesla),
   *   - thumb blanc à halo, chiffre central proportionné (container queries),
   *   - draw-in au montage, état OFF épuré.
   *
   * Contrainte Safari iOS : aucun color-mix() — uniquement oklch() explicite
   * et stop-opacity. Couleurs du dégradé passées par le parent (colorFrom/To).
   *
   * Réutilisable : cumulus, four, etc.
   */
  interface Props {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    /** Accent du mode (chiffre, thumb, ticks actifs, glow). */
    color: string;
    /** Mesure réelle (ex: temp. intérieure) → repère « tu es ici » sur le cadran. */
    currentValue?: number | null;
    /** Bas du dégradé de fill (défaut: color). */
    colorFrom?: string;
    /** Haut du dégradé de fill — la « zone chaude » (défaut: color). */
    colorTo?: string;
    disabled?: boolean;
    /** Sous-label sous le chiffre quand actif (ex: « Cible chaud »). */
    label?: string;
    /** Texte central quand off (ex: « À l'arrêt »). */
    offLabel?: string;
    /** Sous-label en mode off (ex: rappel consignes). */
    offSubLabel?: string;
    onChange: (v: number) => void;
  }

  let {
    value,
    min = 16,
    max = 30,
    step = 0.5,
    color,
    currentValue = null,
    colorFrom,
    colorTo,
    disabled = false,
    label = '',
    offLabel = "À l'arrêt",
    offSubLabel = '',
    onChange
  }: Props = $props();

  const uid = `tg${__tgCounter++}`;

  // ─── Valeur affichée : découplage geste / réseau ────────────────
  // Pendant un glissement (et brièvement après), l'affichage suit une valeur
  // LOCALE qui colle au doigt — sinon le thumb suivrait `value` (piloté par le
  // parent via le réseau), qui fait l'aller-retour store→commande→cloud et
  // produit un yo-yo. onChange n'est émis qu'au relâchement (1 commande, pas 10).
  // Seed neutre : localValue est toujours (ré)écrit dans onPointerDown avant
  // d'être lu via `shown` (jamais affiché hors drag/garde), et l'$effect ci-
  // dessous le resynchronise sur `value` au repos. Le seed n'est donc jamais vu.
  let localValue = $state(0);
  let dragging = $state(false);
  // Garde : ignore les valeurs entrantes périmées un court instant après commit,
  // le temps que le parent/cloud reflète la consigne choisie.
  let holdUntil = $state(0);

  // Valeur réellement affichée (thumb, fill, ticks, chiffre central).
  const shown = $derived(dragging || Date.now() < holdUntil ? localValue : value);

  // Resynchronise la valeur locale sur le parent quand on n'interagit pas et
  // hors fenêtre de garde (ex. consigne changée par un autre client / le poll).
  $effect(() => {
    const v = value; // dépendance trackée
    if (!dragging && Date.now() >= holdUntil) localValue = v;
  });

  // ─── Géométrie (viewBox 200×200) ────────────────────────────────
  const CX = 100;
  const CY = 100;
  const R = 78;
  const STROKE = 12;
  const START = 135; // SW
  const END = 405; // = 45° (SE) → balayage 270°
  const SWEEP = END - START;
  const TICK_IN = R + STROKE / 2 + 4; // anneau de ticks à l'extérieur du track
  const TICK_OUT = R + STROKE / 2 + 9;
  const TICK_ANCHOR = R + STROKE / 2 + 12; // ticks d'ancrage (extrêmes/milieu)

  function polar(angle: number, r: number = R) {
    const rad = (angle * Math.PI) / 180;
    return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
  }

  function arc(from: number, to: number, r: number = R): string {
    const a = polar(from, r);
    const b = polar(to, r);
    const large = to - from > 180 ? 1 : 0;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  }

  const trackPath = arc(START, END);
  const valueAngle = $derived(START + ((shown - min) / (max - min)) * SWEEP);
  const fillPath = $derived(arc(START, valueAngle));
  const thumb = $derived(polar(valueAngle));

  // Repère « mesure réelle » (temp. intérieure), juste à l'intérieur du track,
  // avec un petit trait qui pointe vers l'échelle (lecture d'aiguille).
  const MARKER_R = R - STROKE / 2 - 7;
  const marker = $derived.by(() => {
    if (currentValue == null || currentValue < min || currentValue > max) return null;
    const a = START + ((currentValue - min) / (max - min)) * SWEEP;
    const dot = polar(a, MARKER_R);
    const tipIn = polar(a, MARKER_R + 2.5);
    const tipOut = polar(a, R - STROKE / 2 - 1);
    return { dot, tipIn, tipOut };
  });

  // Ticks à chaque degré entier ; actifs (≤ valeur) teintés du mode.
  const ticks = $derived.by(() => {
    const out: {
      x1: number; y1: number; x2: number; y2: number; active: boolean; anchor: boolean;
    }[] = [];
    for (let t = Math.ceil(min); t <= Math.floor(max); t += 1) {
      const a = START + ((t - min) / (max - min)) * SWEEP;
      const anchor = t === min || t === max || t === Math.round((min + max) / 2);
      const p1 = polar(a, TICK_IN);
      const p2 = polar(a, anchor ? TICK_ANCHOR : TICK_OUT);
      out.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, active: t <= shown + 1e-6, anchor });
    }
    return out;
  });

  // ─── Drag interactif ────────────────────────────────────────────
  let svgEl = $state<SVGSVGElement | null>(null);

  function pointerToValue(ev: PointerEvent): number {
    if (!svgEl) return value;
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * 200;
    const py = ((ev.clientY - rect.top) / rect.height) * 200;
    let deg = (Math.atan2(py - CY, px - CX) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    // Arc 135°→405°. Remap [0,45]→[360,405] ; zone morte du haut [45,135]
    // → snap à l'extrême le plus proche.
    if (deg < 45) deg += 360;
    else if (deg < 135) deg = deg < 90 ? END : START;
    const clamped = Math.max(START, Math.min(END, deg));
    const raw = min + ((clamped - START) / SWEEP) * (max - min);
    return Math.round(raw / step) * step;
  }

  function onPointerDown(ev: PointerEvent) {
    if (disabled || !svgEl) return;
    ev.preventDefault();
    dragging = true;
    svgEl.setPointerCapture(ev.pointerId);
    // L'affichage suit le doigt localement, sans rien envoyer encore.
    localValue = pointerToValue(ev);
  }

  function onPointerMove(ev: PointerEvent) {
    if (!dragging) return;
    // Mise à jour purement locale → thumb collé au doigt, zéro réseau.
    localValue = pointerToValue(ev);
  }

  function onPointerUp(ev: PointerEvent) {
    if (!dragging || !svgEl) return;
    dragging = false;
    try {
      svgEl.releasePointerCapture(ev.pointerId);
    } catch {
      // pointer déjà libéré
    }
    // Commit unique au relâchement. On maintient l'affichage sur la valeur
    // choisie pendant une courte garde, le temps que le parent (store + cloud)
    // reflète la consigne — évite un dernier sursaut vers l'ancienne valeur.
    holdUntil = Date.now() + 1500;
    if (localValue !== value) onChange(localValue);
  }
</script>

<div
  class="gauge-wrap relative aspect-square w-full max-w-[260px]"
  style="--gauge-color: {color}; --gauge-from: {colorFrom ?? color}; --gauge-to: {colorTo ?? color};"
>
  <svg
    bind:this={svgEl}
    viewBox="0 0 200 200"
    class="gauge-svg block h-full w-full"
    class:dragging
    class:disabled
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    role="slider"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={shown}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
  >
    <defs>
      <linearGradient id="{uid}-fill" x1="100" y1="168" x2="100" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="var(--gauge-from)" />
        <stop offset="100%" stop-color="var(--gauge-to)" />
      </linearGradient>
      <radialGradient id="{uid}-glow">
        <stop offset="0%" stop-color="var(--gauge-color)" stop-opacity="0.18" />
        <stop offset="65%" stop-color="var(--gauge-color)" stop-opacity="0" />
      </radialGradient>
    </defs>

    <!-- Glow interne (lit-from-within) -->
    {#if !disabled}
      <circle cx={CX} cy={CY} r="62" fill="url(#{uid}-glow)" />
    {/if}

    <!-- Track -->
    <path d={trackPath} class="gauge-track" fill="none" stroke-width={STROKE} stroke-linecap="round" />

    <!-- Anneau de ticks gradués -->
    {#each ticks as t (t.x1)}
      <line
        x1={t.x1}
        y1={t.y1}
        x2={t.x2}
        y2={t.y2}
        class="gauge-tick"
        class:active={!disabled && t.active}
        class:anchor={t.anchor}
      />
    {/each}

    <!-- Fill dégradé + thumb -->
    {#if !disabled}
      <path
        d={fillPath}
        class="gauge-fill"
        fill="none"
        stroke="url(#{uid}-fill)"
        stroke-width={STROKE}
        stroke-linecap="round"
        pathLength="100"
      />

      <!-- Repère mesure réelle (temp. intérieure) -->
      {#if marker}
        <line
          x1={marker.tipIn.x}
          y1={marker.tipIn.y}
          x2={marker.tipOut.x}
          y2={marker.tipOut.y}
          class="gauge-marker-tick"
        />
        <circle cx={marker.dot.x} cy={marker.dot.y} r="5" class="gauge-marker-halo" />
        <circle cx={marker.dot.x} cy={marker.dot.y} r="2.6" class="gauge-marker" />
      {/if}

      <circle cx={thumb.x} cy={thumb.y} r="13" class="gauge-thumb-glow" />
      <circle cx={thumb.x} cy={thumb.y} r="8.5" class="gauge-thumb" />
      <circle cx={thumb.x} cy={thumb.y} r="3" class="gauge-thumb-core" />
    {/if}
  </svg>

  <!-- Centre : chiffre énorme OU label off -->
  <div class="gauge-center pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
    {#if disabled}
      <div class="off-label">{offLabel}</div>
      {#if offSubLabel}
        <div class="off-sub">{offSubLabel}</div>
      {/if}
    {:else}
      <div class="gauge-value">
        <span class="val-int">{Math.floor(shown)}</span><span class="val-dec"
          >{shown % 1 ? '.5' : ''}</span
        ><span class="val-unit">°</span>
      </div>
      {#if label}
        <div class="gauge-label">{label}</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .gauge-wrap {
    margin-inline: auto;
    container-type: size;
  }
  .gauge-svg {
    touch-action: none;
    cursor: grab;
    -webkit-tap-highlight-color: transparent;
    outline: none;
    overflow: visible;
  }
  .gauge-svg.dragging {
    cursor: grabbing;
  }
  .gauge-svg.disabled {
    cursor: default;
  }
  .gauge-svg:focus-visible {
    filter: drop-shadow(0 0 3px var(--color-primary));
  }

  /* Track : muted profond */
  .gauge-track {
    stroke: var(--color-muted);
    transition: stroke var(--duration-normal) var(--ease-default);
  }

  /* Fill : dégradé + glow, dessiné au montage */
  .gauge-fill {
    transition: d 260ms var(--ease-default);
    filter: drop-shadow(0 0 7px var(--gauge-color));
    stroke-dasharray: 100;
    animation: gauge-draw 850ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes gauge-draw {
    from {
      stroke-dashoffset: 100;
    }
    to {
      stroke-dashoffset: 0;
    }
  }

  /* Thumb : noyau coloré, disque blanc, halo */
  .gauge-thumb {
    fill: #ffffff;
    stroke: var(--color-card);
    stroke-width: 1.5;
    transition: transform var(--duration-fast) var(--ease-default);
  }
  .gauge-thumb-core {
    fill: var(--gauge-color);
    transition: fill 400ms var(--ease-default);
  }
  .gauge-thumb-glow {
    fill: var(--gauge-color);
    opacity: 0.22;
    filter: blur(2px);
    transition: opacity var(--duration-fast) var(--ease-default);
  }
  .gauge-svg.dragging .gauge-thumb-glow {
    opacity: 0.42;
  }

  /* Repère mesure réelle (« tu es ici ») — neutre, distinct du thumb coloré */
  .gauge-marker {
    fill: var(--color-fg);
    transition:
      cx 600ms var(--ease-default),
      cy 600ms var(--ease-default);
  }
  .gauge-marker-halo {
    fill: var(--color-fg);
    opacity: 0.16;
    transition:
      cx 600ms var(--ease-default),
      cy 600ms var(--ease-default);
  }
  .gauge-marker-tick {
    stroke: var(--color-fg);
    stroke-width: 2;
    stroke-linecap: round;
    opacity: 0.55;
    transition:
      x1 600ms var(--ease-default),
      y1 600ms var(--ease-default),
      x2 600ms var(--ease-default),
      y2 600ms var(--ease-default);
  }

  /* Ticks : anneau gradué, actifs teintés du mode */
  .gauge-tick {
    stroke: var(--color-muted-fg);
    stroke-width: 1.6;
    stroke-linecap: round;
    opacity: 0.16;
    transition:
      stroke 300ms var(--ease-default),
      opacity 300ms var(--ease-default);
  }
  .gauge-tick.anchor {
    stroke-width: 2;
    opacity: 0.32;
  }
  .gauge-tick.active {
    stroke: var(--gauge-color);
    opacity: 0.65;
  }
  .gauge-tick.active.anchor {
    opacity: 0.9;
  }
  .gauge-svg.disabled .gauge-tick {
    opacity: 0.1;
  }

  /* ─── Centre : chiffre signature Yeldra (proportionnel au gauge) ─── */
  .gauge-center {
    padding-bottom: 9cqw;
  }
  .gauge-value {
    display: flex;
    align-items: flex-start;
    line-height: 0.82;
    letter-spacing: -0.045em;
    font-variant-numeric: tabular-nums;
    color: var(--gauge-color);
    filter: drop-shadow(0 0 14px var(--gauge-color));
    transition: color 400ms var(--ease-default);
  }
  .val-int {
    font-size: 33cqw;
    font-weight: 200;
  }
  .val-dec {
    font-size: 16cqw;
    font-weight: 300;
    margin-top: 0.55em;
    opacity: 0.72;
  }
  .val-unit {
    font-size: 12cqw;
    font-weight: 300;
    margin-top: 0.5em;
    opacity: 0.62;
  }
  .gauge-label {
    margin-top: 4cqw;
    font-size: 4.2cqw;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--gauge-color);
    opacity: 0.85;
    transition: color 400ms var(--ease-default);
  }

  .off-label {
    font-size: 12cqw;
    font-weight: 250;
    color: var(--color-muted-fg);
    letter-spacing: -0.01em;
    line-height: 1;
  }
  .off-sub {
    margin-top: 4cqw;
    font-size: 3.6cqw;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    opacity: 0.7;
    text-align: center;
    max-width: 78%;
  }

  /* Respecte prefers-reduced-motion : pas de draw-in */
  @media (prefers-reduced-motion: reduce) {
    .gauge-fill {
      animation: none;
      stroke-dasharray: none;
    }
  }
</style>
