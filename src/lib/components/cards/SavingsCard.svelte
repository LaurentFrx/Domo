<script lang="ts">
  /**
   * Carte « Économies solaires » — auto-consommation valorisée au tarif HP/HC
   * évité (jour / mois / année / total), lue du store savings (base recorder).
   *
   * Variante par défaut = HÉRO : 4 médailles de verre sur UNE ligne (légèrement
   * superposées sur iPhone, 4 colonnes dès l'iPad). Rendu STATIQUE (sphères
   * glossy + lueurs douces) — seules animations : le count-up et l'apparition,
   * one-shot (aucune boucle GPU continue, pour ne pas faire chauffer le device).
   * `compact` = variante tassée. Store non connecté → « — » propre.
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

  // ── Count-up : les montants roulent 0 → valeur à l'apparition (one-shot) ──
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
      ` --z:${i + 1}; --d:${i * 110}ms; --bob:${(i * -1.4).toFixed(2)}s;`
    );
  }

  // Police de la valeur dimensionnée pour remplir la bulle sans déborder.
  function valueFz(finalEur: number): number {
    const n = formatCurrency(finalEur).length;
    if (n <= 6) return 24; // "0,71 €"
    if (n === 7) return 20; // "13,42 €"
    if (n === 8) return 17.5; // "224,51 €" / "499,38 €"
    if (n === 9) return 15.5;
    return 14; // ≥ 10 ("1 234,56 €")
  }

  // MÊME taille de police sur les 4 bulles : la plus petite (= tient pour la plus longue).
  const uniformFz = $derived(
    Math.min(valueFz(today.eur), valueFz(month.eur), valueFz(year.eur), valueFz(total.eur))
  );
</script>

{#if compact}
  <!-- ═══ Variante compacte ═══ -->
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
  <!-- ═══ Carte HÉRO ═══ -->
  <section
    class="solar-hero rounded-[var(--radius-3xl)] border p-5 sm:p-6"
    class:animate={rich}
    class:disconnected={!connected}
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <!-- Lueur d'ambiance STATIQUE (aucune animation). -->
    <div class="sky-static" aria-hidden="true"></div>

    <div class="content relative flex flex-col gap-5">
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

  /* Lueur d'ambiance figée (2 dégradés radiaux, aucun coût d'animation). */
  .sky-static {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    z-index: 0;
    background:
      radial-gradient(circle at 50% -15%, oklch(0.82 0.16 82 / 0.16), transparent 55%),
      radial-gradient(circle at 112% 118%, oklch(0.86 0.2 152 / 0.13), transparent 55%);
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
  .orbs {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 0.4rem;
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

  /* Apparition (one-shot) + flottement GPU-composité (transform seul → quasi gratuit). */
  .solar-hero.animate .orb-wrap {
    animation:
      fade-in 600ms ease backwards var(--d),
      bob 5.5s ease-in-out infinite var(--bob);
  }
  /* Halo coloré doux (dégradé radial seul, SANS filter:blur → pas de re-raster). */
  .orb-halo {
    position: absolute;
    inset: -10%;
    border-radius: 9999px;
    background: radial-gradient(circle, var(--orb-glow), transparent 66%);
    opacity: 0.7;
    z-index: 0;
  }
  /* Lueur qui respire (OPACITÉ seule → compositée, pas de blur animé). */
  .solar-hero.animate .orb-halo {
    animation: halo-glow 5.5s ease-in-out infinite var(--bob);
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
      0 12px 26px -10px var(--orb-glow),
      inset 3px 3px 8px oklch(0.99 0.012 286 / 0.55),
      inset -5px -6px 13px oklch(0.2 0.05 286 / 0.45);
    transition: transform 240ms var(--ease-default, cubic-bezier(0.4, 0, 0.2, 1));
  }
  /* Reflet spéculaire glossy (statique). */
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
  .orb-wrap:hover .orb {
    transform: scale(1.05);
  }
  /* Flaque de lumière sous la médaille (dégradé radial seul, sans blur). */
  .orb-reflection {
    position: absolute;
    left: 16%;
    right: 16%;
    bottom: -6%;
    height: 16%;
    border-radius: 9999px;
    background: radial-gradient(ellipse, var(--orb-glow), transparent 70%);
    opacity: 0.6;
    z-index: 0;
  }
  /* Anneau « live » sur la sphère Aujourd'hui — pulse en OPACITÉ (compositée). */
  .ring {
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    box-shadow: 0 0 0 2px var(--orb-glow);
    z-index: 2;
  }
  .solar-hero.animate .ring {
    animation: ring-pulse 2.8s ease-in-out infinite;
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
  .cov-badge.dim .cov-dot {
    background: var(--color-muted-fg);
    box-shadow: none;
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
  .split {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted-fg);
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
      transform: translateY(-5px);
    }
  }
  @keyframes halo-glow {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 0.95;
    }
  }
  @keyframes ring-pulse {
    0%,
    100% {
      opacity: 0.85;
    }
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .solar-hero.animate .orb-wrap,
    .solar-hero.animate .orb-halo,
    .solar-hero.animate .ring {
      animation: none;
    }
  }
</style>
