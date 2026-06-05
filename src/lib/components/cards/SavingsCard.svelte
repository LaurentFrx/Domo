<script lang="ts">
  /**
   * Carte « Économies solaires » — auto-consommation valorisée au tarif HP/HC
   * évité (jour / mois / année / total), lue du store savings (base recorder).
   *
   * Variante par défaut = HÉRO « Solar Harvest » (page Énergie) : 4 médailles de
   * verre sur UNE ligne (légèrement superposées sur iPhone, 4 colonnes dès l'iPad),
   * qui comptent en montant, flottent et brillent ; soleil + ciel d'ambiance.
   * Valeurs auto-ajustées pour remplir chaque bulle sans déborder. `compact` =
   * variante tassée (accueil). Store non connecté → « — » propre. Animations gated
   * (preferences + prefers-reduced-motion).
   */
  import { savings } from '$stores/savings.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { formatCurrency } from '$utils/format';
  import { Tween } from 'svelte/motion';
  import { expoOut } from 'svelte/easing';

  interface Props {
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  const DASH = '—';
  const eur = (v: number) => formatCurrency(v);

  const connected = $derived(savings.connected);
  const today = $derived(savings.today);
  const month = $derived(savings.month);
  const year = $derived(savings.year);
  const total = $derived(savings.total);

  const rate = $derived(today.rate_eur_h);
  const showRate = $derived(connected && rate > 0.0005);
  const coverage = $derived(Math.round(today.coverage_pct));
  const hasCoverage = $derived(connected && today.kwh > 0);

  const animate = $derived(preferences.animationsEnabled);

  // Respect de prefers-reduced-motion (accessibilité, jamais désactivé).
  let reducedMotion = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const rich = $derived(animate && !reducedMotion);

  // ── Count-up : les montants roulent 0 → valeur à l'apparition (et au refresh) ──
  const tToday = new Tween(0, { easing: expoOut });
  const tMonth = new Tween(0, { easing: expoOut });
  const tYear = new Tween(0, { easing: expoOut });
  const tTotal = new Tween(0, { easing: expoOut });
  $effect(() => {
    const d = rich ? 1400 : 0;
    tToday.set(connected ? today.eur : 0, { duration: d });
    tMonth.set(connected ? month.eur : 0, { duration: d });
    tYear.set(connected ? year.eur : 0, { duration: d });
    tTotal.set(connected ? total.eur : 0, { duration: d });
  });

  // Palettes des médailles (cool → chaud), oklch DIRECT (jamais color-mix en box-shadow).
  const PALETTES: Record<string, { light: string; base: string; dark: string; glow: string }> = {
    today: {
      light: 'oklch(0.78 0.15 262)',
      base: 'oklch(0.56 0.19 262)',
      dark: 'oklch(0.40 0.16 262)',
      glow: 'oklch(0.58 0.19 262 / 0.55)'
    },
    month: {
      light: 'oklch(0.84 0.17 150)',
      base: 'oklch(0.60 0.17 150)',
      dark: 'oklch(0.42 0.14 150)',
      glow: 'oklch(0.62 0.18 150 / 0.55)'
    },
    year: {
      light: 'oklch(0.90 0.15 85)',
      base: 'oklch(0.71 0.16 80)',
      dark: 'oklch(0.52 0.13 70)',
      glow: 'oklch(0.78 0.16 82 / 0.55)'
    },
    total: {
      light: 'oklch(0.78 0.18 28)',
      base: 'oklch(0.57 0.21 27)',
      dark: 'oklch(0.41 0.17 27)',
      glow: 'oklch(0.60 0.21 27 / 0.55)'
    }
  };

  const orbs = $derived([
    { key: 'today', label: "Aujourd'hui", v: tToday.current, final: today.eur, live: true },
    { key: 'month', label: 'Mois', v: tMonth.current, final: month.eur, live: false },
    { key: 'year', label: 'Année', v: tYear.current, final: year.eur, live: false },
    { key: 'total', label: 'Total', v: tTotal.current, final: total.eur, live: false }
  ]);

  function orbStyle(key: string, i: number): string {
    const p = PALETTES[key];
    return (
      `--orb-light:${p.light}; --orb-base:${p.base}; --orb-dark:${p.dark}; --orb-glow:${p.glow};` +
      ` --z:${i + 1}; --d:${i * 120}ms; --bob:${(i * -1.3).toFixed(2)}s; --shim:${(i * 1.4).toFixed(2)}s;`
    );
  }

  // Police de la valeur dimensionnée pour remplir la bulle sans déborder, selon la
  // longueur du nombre FINAL (pas l'animé → pas de saut pendant le count-up).
  // 1cqmin = 1 % du diamètre de la bulle (container-query) → scale auto.
  function valueFz(finalEur: number): number {
    const n = formatCurrency(finalEur).length;
    if (n <= 6) return 24; // "0,71 €"
    if (n === 7) return 20; // "13,42 €"
    if (n === 8) return 17.5; // "224,51 €" / "499,38 €"
    if (n === 9) return 15.5;
    return 14; // ≥ 10 ("1 234,56 €")
  }

  // MÊME taille de police sur les 4 bulles : on prend la plus petite (= celle qui
  // tient pour la valeur la plus longue) et on l'applique à toutes.
  const uniformFz = $derived(
    Math.min(valueFz(today.eur), valueFz(month.eur), valueFz(year.eur), valueFz(total.eur))
  );

  // Photons dorés montants — params FIXES (pas de Math.random : hydratation SSR).
  const PHOTONS = [
    { x: 6, s: 3, d: -1.2, t: 8.5, dr: 12, o: 0.7 },
    { x: 16, s: 4, d: -4.8, t: 10, dr: -8, o: 0.85 },
    { x: 27, s: 2, d: -7.5, t: 7, dr: 10, o: 0.6 },
    { x: 39, s: 5, d: -2.3, t: 11, dr: -14, o: 0.9 },
    { x: 50, s: 3, d: -9.1, t: 9, dr: 6, o: 0.7 },
    { x: 61, s: 2, d: -5.6, t: 7.5, dr: -10, o: 0.55 },
    { x: 73, s: 4, d: -0.6, t: 10.5, dr: 12, o: 0.8 },
    { x: 84, s: 3, d: -8.2, t: 8, dr: -6, o: 0.7 },
    { x: 93, s: 5, d: -3.4, t: 11.5, dr: 14, o: 0.9 },
    { x: 34, s: 2, d: -6.9, t: 7, dr: -12, o: 0.6 },
    { x: 68, s: 3, d: -1.9, t: 9.5, dr: 8, o: 0.75 }
  ];
</script>

{#if compact}
  <!-- ═══ Variante compacte (accueil) ═══ -->
  <div
    class="flex flex-col gap-2 rounded-[var(--radius-xl)] border p-4"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex items-center justify-between gap-2">
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Économies solaires
      </span>
      {#if hasCoverage}
        <span
          class="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em]"
          style="background: var(--color-solar-muted); color: var(--color-solar);"
        >
          {coverage}% solaire
        </span>
      {/if}
    </div>

    <div class="flex items-baseline gap-2">
      <span
        class="text-[24px] leading-none font-semibold tabular-nums sm:text-[28px]"
        style="color: var(--color-fg); letter-spacing: -0.01em;"
      >
        {connected ? eur(today.eur) : DASH}
      </span>
      <span class="text-[12px]" style="color: var(--color-muted-fg);">aujourd'hui</span>
      {#if showRate}
        <span
          class="ml-auto text-[12px] font-semibold tabular-nums"
          style="color: var(--color-battery);"
        >
          +{eur(rate)}/h
        </span>
      {/if}
    </div>

    <div
      class="flex items-center justify-between text-[11px] tabular-nums"
      style="color: var(--color-muted-fg);"
    >
      <span
        >Mois <span style="color: var(--color-fg);">{connected ? eur(month.eur) : DASH}</span></span
      >
      <span
        >Année <span style="color: var(--color-fg);">{connected ? eur(year.eur) : DASH}</span></span
      >
      <span
        >Total <span style="color: var(--color-fg);">{connected ? eur(total.eur) : DASH}</span
        ></span
      >
    </div>
  </div>
{:else}
  <!-- ═══ Carte HÉRO « Solar Harvest » (page Énergie) ═══ -->
  <section
    class="solar-hero rounded-[var(--radius-3xl)] border p-5 sm:p-6"
    class:animate={rich}
    class:disconnected={!connected}
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <!-- ── Ciel animé ── -->
    {#if rich}
      <div class="sky" aria-hidden="true">
        <div class="sunburst"></div>
        <div class="suncore"></div>
        <div class="aurora"></div>
        <div class="photons">
          {#each PHOTONS as p, i (i)}
            <span
              class="photon"
              style="left:{p.x}%; width:{p.s}px; height:{p.s}px; animation-delay:{p.d}s; animation-duration:{p.t}s; --dr:{p.dr}px; --po:{p.o};"
            ></span>
          {/each}
        </div>
      </div>
    {:else}
      <div class="sky-static" aria-hidden="true"></div>
    {/if}

    <div class="content relative flex flex-col gap-5">
      <!-- En-tête : titre dégradé -->
      <header class="hero-head">
        <span class="hero-title">Économies solaires</span>
        <span class="hero-sub">Auto-consommation valorisée</span>
      </header>

      <!-- Les 4 médailles (1 ligne superposée sur iPhone, 4 colonnes dès sm) -->
      <div class="orbs">
        {#each orbs as o, i (o.key)}
          <div class="orb-wrap" style={orbStyle(o.key, i)}>
            <span class="orb-halo" aria-hidden="true"></span>
            <div class="orb" class:live={o.live}>
              {#if o.live}<span class="ring" aria-hidden="true"></span>{/if}
              <span class="orb-value" style="--fz: {uniformFz}">{connected ? eur(o.v) : DASH}</span>
              <span class="orb-label">{o.label}</span>
            </div>
            <span class="orb-reflection" aria-hidden="true"></span>
          </div>
        {/each}
      </div>

      <!-- Pied : couverture · débit live €/h (commun) · ventilation HP/HC -->
      <footer class="hero-foot">
        <span class="cov-badge" class:dim={!hasCoverage}>
          <span class="cov-dot" aria-hidden="true"></span>
          {hasCoverage ? `${coverage}% solaire` : `${DASH} solaire`}
        </span>
        {#if showRate}
          <span class="rate">+{eur(rate)}/h</span>
        {/if}
        <span class="split">
          <span style="color: var(--color-hp);">HP {connected ? eur(today.eur_hp) : DASH}</span>
          <span style="color: var(--color-hc);">HC {connected ? eur(today.eur_hc) : DASH}</span>
        </span>
      </footer>
    </div>
  </section>
{/if}

<style>
  .solar-hero {
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }
  .content {
    z-index: 2;
  }

  /* ───────────── Ciel animé ───────────── */
  .sky,
  .sky-static {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    overflow: hidden;
    pointer-events: none;
    z-index: 0;
  }
  .sky-static {
    background:
      radial-gradient(circle at 50% -20%, oklch(0.82 0.16 82 / 0.18), transparent 55%),
      radial-gradient(circle at 110% 120%, oklch(0.86 0.2 152 / 0.14), transparent 55%);
  }
  .sunburst {
    position: absolute;
    width: 560px;
    height: 560px;
    left: 50%;
    top: -330px;
    transform: translateX(-50%);
    background: repeating-conic-gradient(
      from 0deg,
      oklch(0.88 0.16 84 / 0.16) 0deg 3.5deg,
      transparent 3.5deg 13deg
    );
    border-radius: 50%;
    -webkit-mask: radial-gradient(circle, #000 12%, transparent 60%);
    mask: radial-gradient(circle, #000 12%, transparent 60%);
    animation: spin 64s linear infinite;
    will-change: transform;
  }
  .suncore {
    position: absolute;
    width: 380px;
    height: 380px;
    left: 50%;
    top: -210px;
    transform: translateX(-50%);
    background: radial-gradient(
      circle,
      oklch(0.92 0.13 86 / 0.4),
      oklch(0.82 0.17 80 / 0.18) 40%,
      transparent 66%
    );
    animation: breathe 6s ease-in-out infinite;
    will-change: transform, opacity;
  }
  .aurora {
    position: absolute;
    left: -10%;
    right: -10%;
    bottom: -60px;
    height: 220px;
    background: radial-gradient(
      ellipse 60% 100% at 50% 100%,
      oklch(0.86 0.2 152 / 0.22),
      transparent 70%
    );
    animation: drift 9s ease-in-out infinite;
    will-change: transform;
  }
  .photons {
    position: absolute;
    inset: 0;
  }
  .photon {
    position: absolute;
    bottom: -10px;
    border-radius: 9999px;
    background: radial-gradient(
      circle,
      oklch(0.95 0.13 86),
      oklch(0.82 0.17 80 / 0.2) 70%,
      transparent
    );
    box-shadow: 0 0 8px oklch(0.88 0.16 84 / 0.8);
    opacity: 0;
    animation-name: rise;
    animation-timing-function: ease-in;
    animation-iteration-count: infinite;
    will-change: transform, opacity;
  }

  /* ───────────── En-tête ───────────── */
  .hero-head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    text-align: center;
  }
  .hero-title {
    font-size: clamp(20px, 5vw, 26px);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.05;
    background: linear-gradient(
      96deg,
      oklch(0.88 0.16 84),
      oklch(0.82 0.15 50) 42%,
      var(--color-primary) 96%
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .hero-sub {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }

  /* ───────────── Médailles ───────────── */
  /* iPhone : 1 seule ligne, médailles légèrement superposées (pièces empilées). */
  .orbs {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 0.4rem;
    /* déborde légèrement dans le padding de la carte → bleu plus à gauche, rouge
       plus à droite (moins de marge sur les côtés extérieurs). */
    margin-inline: -0.4rem;
  }
  .orb-wrap {
    position: relative;
    flex: 0 0 auto;
    width: clamp(66px, 21vw, 104px);
    aspect-ratio: 1;
    margin-left: -8px;
    z-index: var(--z);
  }
  .orb-wrap:first-child {
    margin-left: 0;
  }
  .orb-wrap:hover {
    z-index: 20;
  }
  /* Dès l'iPad/desktop : 4 colonnes franches, sans superposition. */
  @media (min-width: 640px) {
    .orbs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1.1rem;
      padding-bottom: 0;
    }
    .orb-wrap {
      width: 100%;
      max-width: 108px;
      margin: 0 auto;
    }
  }

  .solar-hero.animate .orb-wrap {
    animation:
      fade-in 700ms ease backwards var(--d),
      bob 4.6s ease-in-out infinite var(--bob);
    will-change: transform, opacity;
  }
  .orb-halo {
    position: absolute;
    inset: -11%;
    border-radius: 9999px;
    background: radial-gradient(circle, var(--orb-glow), transparent 68%);
    filter: blur(6px);
    z-index: 0;
  }
  .solar-hero.animate .orb-halo {
    animation: halo 4.6s ease-in-out infinite var(--bob);
  }
  .orb {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center; /* centrage VERTICAL du bloc valeur+label */
    gap: 1px;
    z-index: 1;
    container-type: size; /* → unité cqmin pour la valeur (scale auto) */
    background: radial-gradient(
      circle at 33% 26%,
      var(--orb-light),
      var(--orb-base) 50%,
      var(--orb-dark) 100%
    );
    box-shadow:
      0 14px 34px -8px var(--orb-glow),
      inset 3px 3px 8px oklch(0.99 0.012 286 / 0.55),
      inset -5px -6px 13px oklch(0.2 0.05 286 / 0.45);
    transition: transform 240ms var(--ease-default, cubic-bezier(0.4, 0, 0.2, 1));
  }
  /* Reflet spéculaire glossy. */
  .orb::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(
      ellipse 56% 40% at 32% 19%,
      oklch(0.99 0.012 286 / 0.62),
      transparent 70%
    );
    pointer-events: none;
  }
  /* Balayage de lumière (lent : glisse + longue pause). */
  .orb::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(
      114deg,
      transparent 38%,
      oklch(0.99 0.012 286 / 0.5) 48%,
      transparent 58%
    );
    background-size: 280% 100%;
    background-position: 175% 0;
    mix-blend-mode: screen;
    pointer-events: none;
  }
  .solar-hero.animate .orb::before {
    animation: shimmer 9s cubic-bezier(0.45, 0, 0.2, 1) infinite;
    animation-delay: var(--shim);
  }
  .orb-wrap:hover .orb {
    transform: scale(1.05);
  }
  .orb-reflection {
    position: absolute;
    left: 18%;
    right: 18%;
    bottom: -7%;
    height: 15%;
    border-radius: 9999px;
    background: radial-gradient(ellipse, var(--orb-glow), transparent 72%);
    filter: blur(4px);
    opacity: 0.7;
    z-index: 0;
  }
  .ring {
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    box-shadow: 0 0 0 2px var(--orb-glow);
    z-index: 2;
  }
  .solar-hero.animate .ring {
    animation: pulse 2.6s ease-in-out infinite;
  }
  .orb-value {
    position: relative;
    z-index: 3;
    font-size: calc(var(--fz, 20) * 1cqmin);
    line-height: 1.05;
    white-space: nowrap;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: oklch(0.99 0.012 286);
    text-shadow: 0 1px 4px oklch(0.22 0.06 286 / 0.7);
  }
  .orb-label {
    position: relative;
    z-index: 3;
    font-size: clamp(8px, 2.3vw, 10px);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: oklch(0.99 0.012 286 / 0.88);
    text-shadow: 0 1px 2px oklch(0.22 0.06 286 / 0.7);
  }
  .disconnected .orb {
    filter: saturate(0.3) opacity(0.7);
  }

  /* ───────────── Pied ───────────── */
  .hero-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem 0.9rem;
    border-top: 1px solid var(--color-border);
    padding-top: 0.85rem;
  }
  .cov-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.18rem 0.75rem;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--color-solar);
    background: var(--color-solar-muted);
  }
  .cov-badge.dim {
    color: var(--color-muted-fg);
    background: var(--color-muted);
  }
  .cov-dot {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--color-solar);
    box-shadow: 0 0 7px var(--color-solar);
  }
  .solar-hero.animate .cov-dot {
    animation: blink 2.2s ease-in-out infinite;
  }
  .cov-badge.dim .cov-dot {
    background: var(--color-muted-fg);
    box-shadow: none;
    animation: none;
  }
  .rate {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-battery);
  }
  .rate::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--color-battery);
    box-shadow: 0 0 6px var(--color-battery);
  }
  .solar-hero.animate .rate::before {
    animation: blink 2.2s ease-in-out infinite;
  }
  .split {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted-fg);
  }

  /* ───────────── Keyframes ───────────── */
  @keyframes spin {
    to {
      transform: translateX(-50%) rotate(360deg);
    }
  }
  @keyframes breathe {
    0%,
    100% {
      transform: translateX(-50%) scale(1);
      opacity: 0.85;
    }
    50% {
      transform: translateX(-50%) scale(1.12);
      opacity: 1;
    }
  }
  @keyframes drift {
    0%,
    100% {
      transform: translateX(0) scaleY(1);
      opacity: 0.8;
    }
    50% {
      transform: translateX(5%) scaleY(1.15);
      opacity: 1;
    }
  }
  @keyframes rise {
    0% {
      transform: translateY(0) translateX(0);
      opacity: 0;
    }
    12% {
      opacity: var(--po, 0.8);
    }
    88% {
      opacity: var(--po, 0.8);
    }
    100% {
      transform: translateY(-340px) translateX(var(--dr, 0));
      opacity: 0;
    }
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes bob {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-6px);
    }
  }
  @keyframes halo {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 0.95;
      transform: scale(1.08);
    }
  }
  @keyframes shimmer {
    0% {
      background-position: 175% 0;
    }
    45% {
      background-position: -75% 0;
    }
    100% {
      background-position: -75% 0;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 0;
      transform: scale(1.12);
    }
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  /* Mouvement réduit : on fige tout et on retire les particules/rayons. */
  @media (prefers-reduced-motion: reduce) {
    .solar-hero :global(*) {
      animation: none !important;
    }
    .sunburst,
    .photons {
      display: none;
    }
  }
</style>
