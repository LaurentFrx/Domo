<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { printer, type InkColor } from '$stores/printer.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** La prise Zigbee qui alimente l'imprimante. */
    plug: ZigbeeDevice;
  }

  let { plug }: Props = $props();

  const isOn = $derived(plug.state.state === 'ON');

  function onTogglePlug() {
    if (!plug.available) return;
    haptic('light');
    zigbee.toggle(plug.friendlyName);
  }

  // ─── Couleurs CMYK : pour chaque cartouche, on précalcule :
  // - base : couleur pleine (la barre de fill)
  // - track : couleur très diluée (le fond de la pill)
  // - glow : couleur diffuse pour le box-shadow extérieur
  // - light : variante un poil éclaircie pour le dégradé du fill
  // Pas de color-mix() dans les calculs (mal supporté sur Safari iOS
  // dans certains contextes — notamment à l'intérieur des gradients).
  const INK: Record<InkColor, { base: string; track: string; glow: string; light: string }> = {
    BK: {
      base: 'oklch(0.32 0.005 280)',
      track: 'oklch(0.32 0.005 280 / 0.20)',
      glow: 'oklch(0.45 0.01 280 / 0.45)',
      light: 'oklch(0.45 0.005 280)'
    },
    C: {
      base: 'oklch(0.70 0.20 220)',
      track: 'oklch(0.70 0.20 220 / 0.20)',
      glow: 'oklch(0.70 0.20 220 / 0.55)',
      light: 'oklch(0.82 0.18 220)'
    },
    M: {
      base: 'oklch(0.62 0.27 350)',
      track: 'oklch(0.62 0.27 350 / 0.20)',
      glow: 'oklch(0.62 0.27 350 / 0.55)',
      light: 'oklch(0.78 0.22 350)'
    },
    Y: {
      base: 'oklch(0.86 0.18 95)',
      track: 'oklch(0.86 0.18 95 / 0.22)',
      glow: 'oklch(0.86 0.18 95 / 0.55)',
      light: 'oklch(0.95 0.16 95)'
    }
  };
</script>

<article
  class="printer-tile flex flex-col justify-center rounded-[var(--radius-xl)] border px-3 py-2"
  class:opacity-50={!plug.available}
  class:printer-on={isOn}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- L'objet, sans texte (19/09/2026, toutes mises en page) : ni le nom — l'icône
       le dit — ni ligne d'état. L'icône-interrupteur, et les jauges dès qu'un
       relevé a été vu une fois (mémoire serveur, cf. store). Le relevé se
       relance seul (30 s en erreur) : aucun bouton « réessayer » n'y manque. -->
  <div class="printer-body flex items-center justify-center gap-3">
    <button
      type="button"
      class="printer-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn
        ? 'var(--color-consumption)'
        : 'var(--color-consumption-muted)'}; color: {isOn ? 'white' : 'var(--color-consumption)'};"
      role="switch"
      aria-checked={isOn}
      aria-label="Allumer ou éteindre l'imprimante"
      title="Imprimante"
      onclick={onTogglePlug}
      disabled={!plug.available}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" rx="0.5" />
      </svg>
    </button>

    <!-- Niveaux d'encre CMYK : 4 jauges VERTICALES (remplies de bas en haut), le
         dernier relevé VU affiché tel quel — ni date ni grisé quand l'imprimante
         est hors tension : l'encre ne bouge que quand elle imprime. -->
    {#if printer.inks.length > 0}
      <div class="ink-pills">
        {#each printer.inks as ink (ink.color)}
          {@const c = INK[ink.color]}
          {@const pct = Math.max(0, Math.min(100, ink.percent))}
          <div
            class="ink-pill"
            style="--ink-base: {c.base}; --ink-light: {c.light}; --ink-track: {c.track}; --ink-glow: {c.glow}; --ink-percent: {pct}%;"
            title="{ink.label} · {ink.percent}%"
          >
            <span class="ink-pill-fill" aria-hidden="true"></span>
            <span class="ink-pill-pct" class:ink-low={ink.percent < 10}>{ink.percent}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</article>

<style>
  .printer-tile {
    /* La tuile se taille sur SA largeur (cf. « Tuile étroite » plus bas). */
    container-type: inline-size;
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .printer-tile:hover {
    border-color: var(--color-border-strong);
  }
  /* ─── Glow néon quand l'imprimante est allumée (idem switches ON) ─── */
  /* Utilise oklch(... / alpha) directement plutôt que color-mix() pour
     compatibilité Safari iOS. */
  .printer-on {
    border-color: var(--color-consumption);
    box-shadow:
      0 0 14px oklch(0.546 0.215 262 / 0.5),
      0 0 32px oklch(0.546 0.215 262 / 0.22);
  }
  .printer-on .printer-icon {
    box-shadow:
      0 0 10px oklch(0.546 0.215 262 / 0.55),
      0 0 20px oklch(0.546 0.215 262 / 0.3);
  }
  /* L'icône EST le bouton on/off → curseur + retour tactile. */
  .printer-icon {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }
  .printer-icon:active:not(:disabled) {
    transform: scale(0.94);
  }
  .printer-icon:disabled {
    cursor: not-allowed;
  }

  /* ─── 4 jauges d'encre CMYK VERTICALES (capsules remplies de bas en haut) ─── */
  .ink-pills {
    display: grid;
    grid-template-columns: repeat(4, 22px);
    gap: 10px;
    justify-content: center;
  }
  .ink-pill {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 56px;
    border-radius: 9999px;
    overflow: hidden;
    background: var(--ink-track);
    border: 1px solid var(--ink-base);
    /* glow extérieur — pas de color-mix, pas de transparent : Safari-safe */
    box-shadow: 0 0 10px var(--ink-glow);
    isolation: isolate; /* nouveau stacking context — fiabilise Safari */
    transition: transform var(--duration-fast) var(--ease-default);
  }
  /* Fill : élément réel (pas ::before) — Safari iOS gère plus fiablement.
     Ancré en bas, hauteur = niveau ; haut plat (l'overflow:hidden du parent
     arrondi clippe le bas en capsule). */
  .ink-pill-fill {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--ink-percent, 0%);
    background-color: var(--ink-base);
    background-image: linear-gradient(to top, var(--ink-base), var(--ink-light));
    z-index: 0;
    transition: height 600ms var(--ease-out);
    pointer-events: none;
  }
  .ink-pill:hover {
    transform: translateY(-1px) scale(1.05);
  }

  /* % inscrit DANS la capsule, au-dessus du fill (blanc + ombre = lisible
     sur le track dilué comme sur la couleur pleine). */
  .ink-pill-pct {
    position: relative;
    z-index: 1;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
    text-shadow:
      0 1px 2px oklch(0.1 0.01 286 / 0.6),
      0 0 4px oklch(0.1 0.01 286 / 0.4);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .ink-pill-pct.ink-low {
    color: oklch(0.92 0.08 30);
  }

  /* ─── Tuile étroite (≈ 175 px : à côté de la carte Terrasse sur iPhone) ───
     Icône (40) + jauges (118) côte à côte demandent ~170 px de contenu : on
     empile, l'icône au-dessus des jauges — 124 px de haut, la hauteur de la
     carte voisine. */
  @container (max-width: 259px) {
    .printer-body {
      flex-direction: column;
      gap: 10px;
    }
  }
</style>
