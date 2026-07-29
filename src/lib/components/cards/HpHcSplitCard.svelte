<script lang="ts">
  import type { MonthAgg } from '$stores/energyMonthly.svelte';

  // Répartition Heures Creuses / Heures Pleines des imports réseau, pour les 12
  // mois de l'année affichée (suit le sélecteur de la page Énergie via `data`).
  // Lecture seule. Deux provenances possibles, distinguées visuellement : relevé
  // compteur facturé (tariffs.json) ou ventilation dérivée de la mesure EM-50
  // (mois pas encore relevés, dont le mois en cours) — hachurée + annoncée en clair.
  let { data, labels, year }: { data: MonthAgg[]; labels: string[]; year: number } = $props();

  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const totalHc = $derived(data.reduce((s, m) => s + (m.import_hc_kwh || 0), 0));
  const totalHp = $derived(data.reduce((s, m) => s + (m.import_hp_kwh || 0), 0));
  const totalAll = $derived(totalHc + totalHp);
  const hasData = $derived(totalAll > 0.05);
  const pctHc = $derived(totalAll > 0 ? Math.round((100 * totalHc) / totalAll) : 0);
  const pctHp = $derived(totalAll > 0 ? 100 - pctHc : 0);

  // Référence de volume = plus gros mois (HC + HP) de l'année affichée.
  const maxMonth = $derived(
    data.reduce((mx, m) => Math.max(mx, (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0)), 0)
  );

  const monthTotal = (m: MonthAgg) => (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0);
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

  // DEUX lectures dans une seule barre :
  //  · la HAUTEUR dit la PART creuses/pleines du mois (chaque barre est pleine) —
  //    c'est le sujet de la carte, et ça reste lisible même sur un mois minuscule ;
  //  · la LARGEUR dit le VOLUME du mois. L'import va de 849 kWh en janvier à 15 en
  //    juillet : à échelle de hauteur commune, tout l'été s'écrasait en filets de
  //    2 px. Largeur en RACINE du volume (perception d'aire) et plancher à 38 % :
  //    un petit mois reste cliquable et visible, un gros mois reste dominant.
  // Largeur en PIXELS, pas en % : la colonne fait ~74 px en desktop pour une piste
  // plafonnée à 26 px — un pourcentage du parent saturait le plafond dès 38 % et
  // toutes les barres sortaient à la même largeur.
  const TRACK_MAX_PX = 26;
  const segH = (v: number, tot: number) => (tot > 0 ? (100 * v) / tot : 0);
  const colW = (tot: number) =>
    maxMonth > 0 && tot > 0
      ? TRACK_MAX_PX * (0.38 + 0.62 * Math.sqrt(tot / maxMonth))
      : TRACK_MAX_PX * 0.38;

  // Mois dont la ventilation est estimée (mesure maison) et non relevée au compteur.
  const isEst = (m: MonthAgg) => m.import_split_source === 'local' && monthTotal(m) > 0;
  const estLabels = $derived(data.map((m, i) => (isEst(m) ? labels[i] : null)).filter(Boolean));
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Répartition Heures Creuses / Heures Pleines des imports réseau"
>
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-0.5">
      <span class="text-[14px] font-semibold">Répartition Heures Creuses / Pleines</span>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">Imports réseau · {year}</span>
    </div>
    {#if hasData}
      <span class="text-[12px] font-semibold tabular-nums" style="color: var(--color-muted-fg);">
        {nf0.format(totalAll)} kWh
      </span>
    {/if}
  </div>

  {#if hasData}
    <!-- Proportion globale HC / HP sur l'année affichée -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between text-[12px] font-semibold">
        <span style="color: var(--color-hc);">Creuses {pctHc} %</span>
        <span style="color: var(--color-hp);">{pctHp} % Pleines</span>
      </div>
      <div class="prop-bar">
        <div class="prop-hc" style="width: {pctHc}%;"></div>
        <div class="prop-hp" style="width: {pctHp}%;"></div>
      </div>
      <div
        class="flex justify-between text-[10px] tabular-nums"
        style="color: var(--color-muted-fg);"
      >
        <span>{nf1.format(totalHc)} kWh creuses</span>
        <span>{nf1.format(totalHp)} kWh pleines</span>
      </div>
    </div>

    <!-- Barres par mois : hauteur = part HC/HP, largeur = volume (cf. segH/colW) -->
    <div
      class="bars"
      role="img"
      aria-label="Part Heures Creuses / Pleines par mois — barre d'autant plus large que le mois a consommé"
    >
      {#each data as m, i (i)}
        {@const tot = monthTotal(m)}
        {@const est = isEst(m)}
        <div
          class="col"
          title={tot > 0
            ? `${labels[i]} ${year} — Creuses ${nf1.format(m.import_hc_kwh)} kWh (${pct(
                m.import_hc_kwh,
                tot
              )} %) · Pleines ${nf1.format(m.import_hp_kwh)} kWh (${pct(m.import_hp_kwh, tot)} %)${
                est ? ' · estimé (mesure maison)' : ''
              }`
            : `${labels[i]} ${year} — pas de relevé`}
        >
          <span class="col-val">{tot > 0 ? nf0.format(tot) : ''}</span>
          <div class="track" style="width: {colW(tot)}px;">
            <div class="seg seg-hp" class:est style="height: {segH(m.import_hp_kwh, tot)}%;"></div>
            <div class="seg seg-hc" class:est style="height: {segH(m.import_hc_kwh, tot)}%;"></div>
          </div>
          <span class="col-lbl" class:est>{labels[i]}</span>
        </div>
      {/each}
    </div>

    <!-- Légende -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
      <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
        <span class="dot" style="background: var(--color-hc);"></span> Heures creuses
      </span>
      <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
        <span class="dot" style="background: var(--color-hp);"></span> Heures pleines
      </span>
      <span style="color: var(--color-muted-fg);">Barre large = gros mois</span>
      {#if estLabels.length > 0}
        <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
          <span class="dot dot-est"></span>
          {estLabels.length === 1 ? estLabels[0] : estLabels.join(', ')} : mesuré à la maison, en attente
          du relevé EDF
        </span>
      {/if}
    </div>
  {:else}
    <p class="py-3 text-[12px]" style="color: var(--color-muted-fg);">
      Pas de ventilation Heures Creuses / Pleines pour {year}.
    </p>
  {/if}
</section>

<style>
  .prop-bar {
    display: flex;
    height: 12px;
    overflow: hidden;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .prop-hc {
    background: var(--color-hc);
  }
  .prop-hp {
    background: var(--color-hp);
  }
  .prop-hc,
  .prop-hp {
    transition: width var(--duration-slow, 300ms) var(--ease-default, ease);
  }

  /* 12 colonnes, alignées sur la base ; gap serré sur iPhone, plus aéré dès iPad. */
  .bars {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 2px;
    align-items: end;
  }
  @media (min-width: 640px) {
    .bars {
      gap: 6px;
    }
  }
  .col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .col-val {
    min-height: 9px;
    font-size: 8px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted-fg);
  }
  /* Piste : barre empilée HP (haut) + HC (bas), ancrée en bas. La largeur est
     posée en ligne (∝ volume du mois, cf. colW) ; le plafond en px garde des
     colonnes fines sur iPhone. */
  .track {
    display: flex;
    max-width: 100%; /* iPhone : la colonne peut être plus étroite que 26 px */
    height: 120px;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    border-radius: var(--radius-sm, 4px);
    background: var(--color-muted);
    transition: width var(--duration-slow, 300ms) var(--ease-default, ease);
  }
  .seg {
    width: 100%;
    transition: height var(--duration-slow, 300ms) var(--ease-default, ease);
  }
  .seg-hp {
    background: var(--color-hp);
  }
  .seg-hc {
    background: var(--color-hc);
  }
  .col-lbl {
    font-size: 9px;
    line-height: 1;
    color: var(--color-muted-fg);
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
  }

  /* Mois ESTIMÉ (ventilation dérivée de la mesure maison, relevé EDF pas encore
     saisi) : hachures diagonales par-dessus la couleur sémantique — la teinte
     HP/HC reste lisible, seule la texture change. Voile SOMBRE teinté charte
     (hue 262, jamais noir pur) : --color-hc et --color-hp sont clairs (L 0,82 et
     0,74) et identiques dans les deux thèmes, une hachure claire s'y noierait. */
  .seg.est {
    background-image: repeating-linear-gradient(
      45deg,
      transparent 0 3px,
      oklch(0.32 0.06 262 / 0.34) 3px 6px
    );
  }
  .col-lbl.est {
    font-style: italic;
  }
  .dot-est {
    background: var(--color-hc);
    background-image: repeating-linear-gradient(
      45deg,
      transparent 0 1.5px,
      oklch(0.32 0.06 262 / 0.55) 1.5px 3px
    );
  }
</style>
