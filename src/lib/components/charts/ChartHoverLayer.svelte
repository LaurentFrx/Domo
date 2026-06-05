<!--
  Couche de survol réutilisable pour les graphes aire/ligne : curseur vertical,
  point actif cerclé, et étiquette flottante (pastille) qui glisse en douceur.
  Inspiré du tooltip shadcn/Recharts (Yeldra) — code original.

  À placer dans un conteneur `position: relative` couvrant la zone de tracé.
  Le parent calcule la position (xPct/yPct en % du conteneur) et le libellé.
-->
<script lang="ts">
  interface Props {
    /** Afficher la couche (survol actif). */
    show: boolean;
    /** Position horizontale du curseur/point, en % de la largeur (0–100). */
    xPct: number;
    /** Position verticale du point actif, en % de la hauteur (0–100). */
    yPct: number;
    /** Contenu de la pastille (ex. « 1.2 kW · 18:30 »). */
    label: string;
  }
  let { show, xPct, yPct, label }: Props = $props();

  // Pastille bornée pour ne pas déborder du cadre.
  const pillLeft = $derived(Math.min(88, Math.max(12, xPct)));
</script>

{#if show}
  <!-- Curseur vertical -->
  <div
    class="pointer-events-none absolute inset-y-0 w-px"
    style="left: {xPct}%; background: var(--color-border); transition: left 0.12s ease;"
  ></div>

  <!-- Point actif (disque + anneau couleur carte + halo léger) -->
  <div
    class="pointer-events-none absolute size-2 rounded-full"
    style="left: {xPct}%; top: {yPct}%; transform: translate(-50%, -50%);
           background: var(--color-primary);
           box-shadow: 0 0 0 2px var(--color-card), 0 0 0 3.5px color-mix(in oklab, var(--color-primary) 45%, transparent);
           transition: left 0.12s ease, top 0.12s ease;"
  ></div>

  <!-- Étiquette flottante (pastille indigo qui glisse) -->
  <div
    class="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] font-semibold"
    style="left: {pillLeft}%; top: 6px; transform: translateX(-50%);
           background: var(--color-primary); color: var(--color-primary-fg);
           box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.35), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
           transition: left 0.28s ease;"
  >
    {label}
  </div>
{/if}
