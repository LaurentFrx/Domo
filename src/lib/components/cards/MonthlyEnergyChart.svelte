<script lang="ts">
  import type { Bucket } from '$stores/energyDrill.svelte';
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
    highlight = -1,
    scaleMax = 0,
    onOpen
  }: {
    /** Les tranches du niveau courant : 12 mois, les jours d'un mois, ou 24 h. */
    data: Bucket[];
    /** Index à mettre en avant (le mois courant, au niveau année). -1 = aucun. */
    highlight?: number;
    /** Échelle FIXE toutes années (plus gros mois de conso, fourni par l'API) :
     * les hauteurs se comparent d'une année à l'autre. 0 = repli sur le max des
     * données affichées — c'est le cas aux niveaux jour et heure, où l'échelle
     * doit se rebattre pour que le détail reste lisible. */
    scaleMax?: number;
    /** Descendre d'un niveau (null au dernier niveau : le clic ne navigue plus). */
    onOpen?: (key: string) => void;
  } = $props();

  // Même bleu que la barre Réseau EDF de l'accueil (+page.svelte) : l'import
  // réseau garde UNE couleur dans toute l'app. Le solaire et le vert économies
  // viennent des tokens.
  const EDF_BLUE = 'oklch(0.62 0.19 256)';

  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

  const totalAuto = $derived(data.reduce((s, m) => s + (m.autoconso_kwh || 0), 0));
  const anyEst = $derived(data.some((m) => m.autoconso_estimated && (m.autoconso_kwh || 0) > 0));
  const totalImport = $derived(data.reduce((s, m) => s + (m.import_kwh || 0), 0));
  const totalEur = $derived(data.reduce((s, m) => s + (m.savings_eur || 0), 0));

  // Conso du mois = solaire consommé + import. Un mois FUTUR (année courante) ou
  // sans aucune donnée → piste vide, pas un faux zéro.
  const monthTotal = (m: Bucket) => (m.autoconso_kwh || 0) + (m.import_kwh || 0);
  const isEmpty = (m: Bucket) => m.empty || monthTotal(m) <= 0;
  const maxTotal = $derived(
    Math.max(
      scaleMax,
      data.reduce((mx, m) => Math.max(mx, monthTotal(m)), 0)
    )
  );

  // Aux petites échelles (une journée, une heure), l'entier écrase tout à « 0 » :
  // on passe à la décimale dès que le plus gros bucket descend sous 10 kWh.
  const fine = $derived(maxTotal > 0 && maxTotal < 10);
  const fmtVal = (v: number) => (fine ? nf1.format(v) : nf0.format(v));

  // Beaucoup de colonnes (les jours d'un mois, les 24 heures) : sur un écran
  // étroit les étiquettes se chevauchent et deviennent une bouillie. On ne garde
  // alors qu'un repère régulier — le CSS masque le reste sous 640 px seulement,
  // l'iPad affiche tout.
  const dense = $derived(data.length > 16);
  const tickStep = $derived(data.length > 26 ? 5 : data.length > 16 ? 3 : 1);
  const isTick = (i: number) => i % tickStep === 0 || i === data.length - 1;

  const H = 200; // hauteur de piste (px) ; la carte HC/HP en dessous reste à 170
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
  <!-- Barres : hauteur = conso du mois, jaune = payé par le soleil. -->
  <div
    class="bars"
    class:dense
    style="--n: {data.length}; --gap: {data.length > 20 ? 2 : 6}px;"
    role="img"
    aria-label="Consommation par mois — part solaire en jaune, achat réseau en bleu"
  >
    {#each data as m, i (i)}
      {@const empty = isEmpty(m)}
      {@const cur = i === highlight}
      {@const canOpen = !empty && !!m.key && !!onOpen}
      <button
        type="button"
        class="col"
        disabled={empty}
        aria-pressed={selected === i}
        aria-label={empty
          ? `${m.label} — pas de données`
          : canOpen
            ? `${m.label} : ${fmtKwh(monthTotal(m))} consommés — voir le détail`
            : `${m.label} : ${fmtKwh(monthTotal(m))} consommés`}
        onclick={() => {
          if (empty) return;
          // Un clic DESCEND d'un niveau tant qu'il en reste un ; au dernier
          // niveau (les heures), il déplie le détail chiffré comme avant.
          if (canOpen) onOpen?.(m.key as string);
          else selected = selected === i ? null : i;
        }}
      >
        <span class="col-val" class:cur
          >{empty || monthTotal(m) < (fine ? 0.05 : 0.5)
            ? ''
            : `${m.autoconso_estimated ? '~' : ''}${fmtVal(monthTotal(m))}`}</span
        >
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
        <span class="col-lbl" class:cur class:tick={isTick(i)}>{m.label}</span>
        <span class="col-eur">
          {m.savings_eur >= (fine ? 0.05 : 0.5) ? `${fmtVal(m.savings_eur)} €` : ''}
        </span>
      </button>
    {/each}
  </div>

  {#if sel && selected !== null}
    <!-- Le détail chiffré de l'ancien tableau, pour le mois choisi. -->
    <div
      class="flex flex-wrap gap-x-5 gap-y-1 rounded-xl border px-3 py-2.5 text-[12px]"
      style="border-color: var(--color-border); background: var(--color-muted); color: var(--color-muted-fg);"
    >
      <span class="font-semibold" style="color: var(--color-fg);">{sel.label}</span>
      <span
        >Production <strong style="color: var(--color-fg);">{fmtKwh(sel.production_kwh)}</strong
        ></span
      >
      <span
        >Autoconsommé <strong style="color: var(--color-fg);"
          >{sel.autoconso_estimated
            ? `~${fmtKwh(sel.autoconso_kwh)}`
            : fmtKwh(sel.autoconso_kwh)}</strong
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
    /* Autant de colonnes que de tranches : 12 mois, 28 à 31 jours, ou 24 heures.
       minmax(0,1fr) est indispensable — sans lui, une colonne au contenu large
       (l'étiquette « 31 ») force un débordement au lieu de se comprimer. */
    grid-template-columns: repeat(var(--n, 12), minmax(0, 1fr));
    gap: 3px;
    align-items: end;
  }
  @media (min-width: 640px) {
    .bars {
      gap: var(--gap, 6px);
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
  .col:disabled {
    cursor: default;
  }
  .col-val {
    min-height: 9px;
    font-size: 8px;
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
    height: 200px;
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
    font-size: 9px;
    line-height: 1;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }

  /* Écran étroit + beaucoup de colonnes : seuls les repères restent, et les
     valeurs chiffrées s'effacent (elles se chevauchaient). Tout revient dès
     640 px — l'iPad affiche la totalité. */
  @media (max-width: 639px) {
    .bars.dense :global(.col-val),
    .bars.dense :global(.col-eur) {
      display: none;
    }
    .bars.dense :global(.col-lbl:not(.tick)) {
      visibility: hidden;
    }
    /* Les étiquettes de bord déborderaient de leur colonne (elles sont centrées
       sur ~12 px de large) : on les ancre au bord du graphe. */
    .bars.dense :global(.col:first-child .col-lbl) {
      align-self: flex-start;
    }
    .bars.dense :global(.col:last-child .col-lbl) {
      align-self: flex-end;
    }
  }
  .col-lbl.cur {
    font-weight: 700;
    color: var(--color-primary);
  }
  .col-eur {
    min-height: 10px;
    font-size: 8px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--color-success);
  }
  /* Le solaire ESTIMÉ (reconstruit des € HA, pré-recorder) n'est plus hachuré
     (retiré le 25/08 : détail technique qui abîmait le graphe) — le tilde sur
     les chiffres et la légende suffisent à ne pas le vendre comme une mesure. */
</style>
