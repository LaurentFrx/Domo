<script lang="ts">
  import type { MonthAgg } from '$stores/energyMonthly.svelte';
  import { formatCurrency } from '$utils/format';

  // Bilan mensuel en BARRES (piste « Saisons », canevas Design du 24/08) : chaque
  // mois empile le solaire consommé (jaune) sur l'achat réseau (bleu EDF) — la
  // hauteur dit la conso de la maison, les couleurs disent qui l'a payée. Trois
  // totaux annuels en tête, économies du mois sous chaque barre, détail complet
  // au tap. Remplace l'ancien tableau 5 × 12 : une année SANS solaire (2023-2025,
  // historique Linky) montre des barres toutes bleues — plus jamais un mur de
  // tirets. La ventilation HC/HP reste l'affaire de la carte dédiée en dessous.
  let {
    data,
    labels,
    isCurrentYear,
    currentMonthIdx
  }: { data: MonthAgg[]; labels: string[]; isCurrentYear: boolean; currentMonthIdx: number } =
    $props();

  // Même bleu que la barre Réseau EDF de l'accueil (+page.svelte) : l'import
  // réseau garde UNE couleur dans toute l'app. Le solaire et le vert économies
  // viennent des tokens.
  const EDF_BLUE = 'oklch(0.62 0.19 256)';

  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const totalAuto = $derived(data.reduce((s, m) => s + (m.autoconso_kwh || 0), 0));
  const totalImport = $derived(data.reduce((s, m) => s + (m.import_kwh || 0), 0));
  const totalEur = $derived(data.reduce((s, m) => s + (m.savings_eur || 0), 0));

  // Conso du mois = solaire consommé + import. Un mois FUTUR (année courante) ou
  // sans aucune donnée → piste vide, pas un faux zéro.
  const monthTotal = (m: MonthAgg) => (m.autoconso_kwh || 0) + (m.import_kwh || 0);
  const isEmpty = (m: MonthAgg, i: number) =>
    (isCurrentYear && i > currentMonthIdx) || monthTotal(m) < 0.5;
  const maxTotal = $derived(data.reduce((mx, m) => Math.max(mx, monthTotal(m)), 0));

  const H = 120; // hauteur de piste (px), alignée sur la carte HC/HP
  // Un flux réel mais minuscule reste VISIBLE (plancher 2 px) — le liseré bleu
  // d'un été presque autonome fait partie de l'histoire.
  const segH = (v: number) => (maxTotal > 0 && v > 0 ? Math.max((H * v) / maxTotal, 2) : 0);

  // Détail au tap : un mois sélectionné déplie ses chiffres sous la légende
  // (production, autoconso, import, surplus, économies) — l'équivalent de
  // l'ancienne colonne de tableau, à la demande. Re-tap : referme.
  let selected = $state<number | null>(null);
  // Changement d'année → la sélection ne survit pas (le « Jui » de 2024 n'est
  // pas celui qu'on avait choisi en 2026).
  $effect(() => {
    void data;
    selected = null;
  });
  const sel = $derived(selected !== null ? data[selected] : null);
  const fmtKwh = (v: number) => (Math.round(v) >= 1 ? `${nf0.format(v)} kWh` : '—');
</script>

<div class="flex flex-col gap-4">
  <!-- Totaux de l'année affichée : seuls les flux qui EXISTENT ont un chiffre
       (année pré-solaire → la seule stat est le réseau). -->
  <div class="flex flex-wrap gap-x-8 gap-y-2">
    {#if totalAuto >= 1}
      <div class="flex flex-col gap-0.5">
        <span class="text-[22px] font-extrabold tracking-tight" style="color: var(--color-solar);">
          {nf0.format(totalAuto)}<span
            class="text-[12px] font-semibold"
            style="color: var(--color-muted-fg);"
          >
            kWh</span
          >
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">Solaire consommé</span>
      </div>
    {/if}
    {#if totalImport >= 1}
      <div class="flex flex-col gap-0.5">
        <span class="text-[22px] font-extrabold tracking-tight" style="color: {EDF_BLUE};">
          {nf0.format(totalImport)}<span
            class="text-[12px] font-semibold"
            style="color: var(--color-muted-fg);"
          >
            kWh</span
          >
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">Réseau EDF</span>
      </div>
    {/if}
    {#if totalEur >= 0.005}
      <div class="flex flex-col gap-0.5">
        <span
          class="text-[22px] font-extrabold tracking-tight"
          style="color: var(--color-success);"
        >
          {nf0.format(totalEur)}<span
            class="text-[12px] font-semibold"
            style="color: var(--color-muted-fg);"
          >
            €</span
          >
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">Économisés</span>
      </div>
    {/if}
  </div>

  <!-- Barres : hauteur = conso du mois, jaune = payé par le soleil. -->
  <div
    class="bars"
    role="img"
    aria-label="Consommation par mois — part solaire en jaune, achat réseau en bleu"
  >
    {#each data as m, i (i)}
      {@const empty = isEmpty(m, i)}
      {@const cur = isCurrentYear && i === currentMonthIdx}
      <button
        type="button"
        class="col"
        aria-pressed={selected === i}
        aria-label={empty
          ? `${labels[i]} — pas de données`
          : `${labels[i]} : ${fmtKwh(monthTotal(m))} consommés`}
        onclick={() => (selected = selected === i || empty ? null : i)}
      >
        <span class="col-val" class:cur>{empty ? '' : nf0.format(monthTotal(m))}</span>
        <div class="track" class:empty class:sel={selected === i}>
          {#if !empty}
            <div
              class="seg"
              style="height: {segH(
                m.autoconso_kwh
              )}px; background: var(--color-solar); border-radius: 5px 5px 0 0;"
            ></div>
            <div
              class="seg"
              style="height: {segH(m.import_kwh)}px; background: {EDF_BLUE}; {(m.autoconso_kwh ||
                0) < 0.5
                ? 'border-radius: 5px 5px 0 0;'
                : ''}"
            ></div>
          {/if}
        </div>
        <span class="col-lbl" class:cur>{labels[i]}</span>
        <span class="col-eur">
          {m.savings_eur >= 0.5 ? `${nf0.format(m.savings_eur)} €` : ''}
        </span>
      </button>
    {/each}
  </div>

  <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
    {#if totalAuto >= 1}
      <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
        <span class="dot" style="background: var(--color-solar);"></span> Solaire consommé
      </span>
    {/if}
    <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
      <span class="dot" style="background: {EDF_BLUE};"></span> Réseau EDF
    </span>
    {#if totalEur >= 0.005}
      <span class="inline-flex items-center gap-1.5" style="color: var(--color-muted-fg);">
        <span class="dot" style="background: var(--color-success);"></span> Économies du mois
      </span>
    {/if}
  </div>

  {#if sel && selected !== null}
    <!-- Le détail chiffré de l'ancien tableau, pour le mois choisi. -->
    <div
      class="flex flex-wrap gap-x-5 gap-y-1 rounded-xl border px-3 py-2.5 text-[12px]"
      style="border-color: var(--color-border); background: var(--color-muted); color: var(--color-muted-fg);"
    >
      <span class="font-semibold" style="color: var(--color-fg);">{labels[selected]}</span>
      <span
        >Production <strong style="color: var(--color-fg);">{fmtKwh(sel.production_kwh)}</strong
        ></span
      >
      <span
        >Autoconsommé <strong style="color: var(--color-fg);">{fmtKwh(sel.autoconso_kwh)}</strong
        ></span
      >
      <span>Réseau <strong style="color: var(--color-fg);">{fmtKwh(sel.import_kwh)}</strong></span>
      <span>Surplus <strong style="color: var(--color-fg);">{fmtKwh(sel.surplus_kwh)}</strong></span
      >
      <span
        >Économies
        <strong style="color: var(--color-success);"
          >{sel.savings_eur >= 0.005 ? formatCurrency(sel.savings_eur) : '—'}</strong
        ></span
      >
    </div>
  {/if}
</div>

<style>
  .bars {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 3px;
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
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    cursor: pointer;
  }
  .col-val {
    min-height: 10px;
    font-size: 9px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted-fg);
  }
  .col-val.cur {
    font-weight: 700;
  }
  .track {
    display: flex;
    width: 100%;
    height: 120px;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    border-radius: 5px;
    background: var(--color-muted);
    transition: box-shadow var(--duration-fast, 150ms) var(--ease-default, ease);
  }
  .track.empty {
    opacity: 0.45;
  }
  .track.sel {
    box-shadow: 0 0 0 2px var(--color-primary);
  }
  .seg {
    width: 100%;
    transition: height var(--duration-slow, 300ms) var(--ease-default, ease);
  }
  .col-lbl {
    font-size: 10px;
    line-height: 1;
    color: var(--color-muted-fg);
  }
  .col-lbl.cur {
    font-weight: 700;
    color: var(--color-primary);
  }
  .col-eur {
    min-height: 11px;
    font-size: 9px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--color-success);
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
  }
</style>
