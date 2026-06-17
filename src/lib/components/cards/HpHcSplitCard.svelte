<script lang="ts">
  import type { MonthAgg } from '$stores/energyMonthly.svelte';

  // Répartition Heures Creuses / Heures Pleines des imports réseau, pour les 12
  // mois de l'année affichée (suit le sélecteur de la page Énergie via `data`).
  // Lecture seule : la ventilation HP/HC vient des relevés compteur (tariffs.json).
  let { data, labels, year }: { data: MonthAgg[]; labels: string[]; year: number } = $props();

  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const totalHc = $derived(data.reduce((s, m) => s + (m.import_hc_kwh || 0), 0));
  const totalHp = $derived(data.reduce((s, m) => s + (m.import_hp_kwh || 0), 0));
  const totalAll = $derived(totalHc + totalHp);
  const hasData = $derived(totalAll > 0.05);
  const pctHc = $derived(totalAll > 0 ? Math.round((100 * totalHc) / totalAll) : 0);
  const pctHp = $derived(totalAll > 0 ? 100 - pctHc : 0);

  // Échelle commune des barres = plus gros mois (HC + HP) de l'année affichée.
  const maxMonth = $derived(
    data.reduce((mx, m) => Math.max(mx, (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0)), 0)
  );

  const monthTotal = (m: MonthAgg) => (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0);
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
  // Hauteur d'un segment en % de la piste (∝ kWh, échelle = maxMonth).
  const segH = (v: number) => (maxMonth > 0 ? (100 * v) / maxMonth : 0);
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

    <!-- Barres empilées par mois (kWh absolu, échelle commune) -->
    <div class="bars" role="img" aria-label="Imports Heures Creuses / Pleines par mois">
      {#each data as m, i (i)}
        {@const tot = monthTotal(m)}
        <div
          class="col"
          title={tot > 0
            ? `${labels[i]} ${year} — Creuses ${nf1.format(m.import_hc_kwh)} kWh (${pct(
                m.import_hc_kwh,
                tot
              )} %) · Pleines ${nf1.format(m.import_hp_kwh)} kWh (${pct(m.import_hp_kwh, tot)} %)`
            : `${labels[i]} ${year} — pas de relevé`}
        >
          <span class="col-val">{tot > 0 ? nf0.format(tot) : ''}</span>
          <div class="track">
            <div class="seg seg-hp" style="height: {segH(m.import_hp_kwh)}%;"></div>
            <div class="seg seg-hc" style="height: {segH(m.import_hc_kwh)}%;"></div>
          </div>
          <span class="col-lbl">{labels[i]}</span>
        </div>
      {/each}
    </div>

    <!-- Légende -->
    <div class="flex items-center gap-4 text-[11px]" style="color: var(--color-muted-fg);">
      <span class="inline-flex items-center gap-1.5">
        <span class="dot" style="background: var(--color-hc);"></span> Heures creuses
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="dot" style="background: var(--color-hp);"></span> Heures pleines
      </span>
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
  /* Piste : barre empilée HP (haut) + HC (bas), ancrée en bas. */
  .track {
    display: flex;
    width: 100%;
    max-width: 26px;
    height: 120px;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    border-radius: var(--radius-sm, 4px);
    background: var(--color-muted);
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
</style>
