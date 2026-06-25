<script lang="ts">
  /**
   * Réseau EDF en chiffre HÉROS temps réel — le signal local le plus actionnable
   * quand on jongle avec les appareils (soutirage vs injection). Mesure EM-50
   * (sub-seconde, fiable), animée d'un Tween COURT pour rester « crisp » (≠ le
   * Sankey, lissé 600 ms). Carte « verre » via background:var(--color-card)
   * (mécanisme d'éclairage centralisé dans app.css).
   */
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  interface Props {
    /** Réseau net signé (W) : + soutirage EDF / − injection PV. */
    gridPowerW: number;
    /** Mesure locale instantanée (EM-50) vs repli lissé (Linky ~5 min). */
    live?: boolean;
    /** Animations activées (préférence + reduced-motion arbitrés par l'appelant). */
    animate?: boolean;
  }
  let { gridPowerW, live = true, animate = true }: Props = $props();

  // Tween COURT (250 ms) : le réseau est l'info « instantanée » → on la veut nette.
  const tw = new Tween(0, { easing: cubicOut });
  $effect(() => void tw.set(gridPowerW, { duration: animate ? 250 : 0, easing: cubicOut }));
  const w = $derived(tw.current);

  const importing = $derived(w > 5); // soutirage EDF
  const exporting = $derived(w < -5); // injection / surplus
  const label = $derived(
    importing ? 'Soutiré au réseau' : exporting ? 'Injecté (surplus)' : 'Équilibré'
  );
  // Sémantique d'énergie : import = conso (indigo), injection = solaire (ambre).
  const color = $derived(
    importing
      ? 'var(--color-consumption)'
      : exporting
        ? 'var(--color-solar)'
        : 'var(--color-muted-fg)'
  );

  function fmtW(v: number): string {
    return Math.round(Math.abs(v)).toLocaleString('fr-FR').replace(/\s/g, ' ');
  }
</script>

<div class="grid-hero rounded-3xl border px-4 py-3" style="background: var(--color-card);">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        style="background: {live ? 'var(--color-glow-bright)' : 'var(--color-warning)'};"
        aria-hidden="true"
      ></span>
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);">Réseau EDF</span
      >
    </div>
    <span class="text-[11px]" style="color: var(--color-muted-fg);"
      >{live ? 'temps réel' : '~5 min (Linky)'}</span
    >
  </div>
  <div class="mt-1 flex items-baseline gap-2">
    <span class="text-3xl font-bold tabular-nums" style="color: {color};">
      {importing ? '+' : exporting ? '−' : ''}{fmtW(w)}<span
        class="ml-0.5 text-sm font-medium"
        style="color: var(--color-muted-fg);">W</span
      >
    </span>
    <span class="text-sm" style="color: var(--color-muted-fg);">{label}</span>
  </div>
</div>
