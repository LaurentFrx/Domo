<script lang="ts">
  import type { Bucket } from '$stores/energyDrill.svelte';

  // Répartition Heures Creuses / Heures Pleines des imports réseau, pour les 12
  // mois de l'année affichée (suit le sélecteur de la page Énergie via `data`).
  // Lecture seule. Les barres parlent la MÊME langue que le graphe Saisons juste
  // au-dessus (demande Laurent 24/08) : largeur constante, hauteur = volume
  // d'import du mois sur l'échelle FIXE commune — la barre d'un mois arrive à la
  // même hauteur que sa part bleue dans le graphe du dessus ; l'empilement
  // cyan/corail dit la répartition. Provenances distinguées : relevé compteur
  // facturé (tariffs.json) ou ventilation estimée — annoncée en clair. Les
  // pistes sont TOUJOURS dessinées, même sans la moindre ventilation : une
  // tranche antérieure aux 24 mois de courbe conservés par Enedis est un
  // placeholder en pointillé (demande Laurent 04/09), pas un paragraphe.
  let {
    data,
    periode,
    scaleMaxKwh = 0,
    pending = false,
    curveFloor = null,
    onOpen
  }: {
    /** Les tranches du niveau courant : 12 mois, les jours d'un mois, ou 24 h. */
    data: Bucket[];
    /** Sous-titre : « 2026 », « Août 2026 », « 14 août 2026 ». */
    periode: string;
    /** Échelle FIXE commune avec le graphe Saisons (plus gros mois de CONSO,
     * toutes années — fourni par l'API) : les hauteurs des deux graphes se
     * comparent. 0 = repli sur le max des données affichées. */
    scaleMaxKwh?: number;
    /** La courbe ½h de cette période n'est pas encore récupérée chez Enedis (le
     * backfill remonte le temps) : on le dit, au lieu de laisser croire qu'elle
     * n'existera jamais. */
    pending?: boolean;
    /** Premier jour que la courbe ½h peut encore couvrir chez Enedis (24 mois
     * glissants, fourni par l'API) : au niveau année, on explique POURQUOI une
     * année ancienne n'a pas de répartition, au lieu d'un « pas de ventilation »
     * qui ressemble à un oubli. */
    curveFloor?: string | null;
    /** Descendre d'un niveau (absent au dernier niveau). */
    onOpen?: (key: string) => void;
  } = $props();

  // Tranche ENTIÈREMENT antérieure au plancher des 24 mois d'Enedis : la courbe
  // n'existera jamais → piste en pointillé (placeholder), et non une piste
  // « vide » qui laisserait croire à un relevé manquant. Un mois se compare par
  // son dernier jour ('2024-08-31' < '2024-09-04' : août hors de portée,
  // septembre inclus) ; un jour par sa date ; une heure (key null) jamais.
  const isUnreachable = (m: Bucket) =>
    !!curveFloor &&
    !!m.key &&
    (m.key.length === 7 ? `${m.key}-31` < curveFloor : m.key < curveFloor) &&
    monthTotal(m) <= 0;
  const anyUnreachable = $derived(data.some(isUnreachable));
  const floorLabel = $derived(
    curveFloor
      ? new Date(`${curveFloor}T12:00:00Z`).toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        })
      : ''
  );

  const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  const totalHc = $derived(data.reduce((s, m) => s + (m.import_hc_kwh || 0), 0));
  const totalHp = $derived(data.reduce((s, m) => s + (m.import_hp_kwh || 0), 0));
  const totalAll = $derived(totalHc + totalHp);
  const hasData = $derived(totalAll > 0.05);
  const pctHc = $derived(totalAll > 0 ? Math.round((100 * totalHc) / totalAll) : 0);
  const pctHp = $derived(totalAll > 0 ? 100 - pctHc : 0);

  // Échelle de hauteur = celle du graphe Saisons (repli : max de l'année).
  const maxMonth = $derived(
    Math.max(
      scaleMaxKwh,
      data.reduce((mx, m) => Math.max(mx, (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0)), 0)
    )
  );

  const monthTotal = (m: Bucket) => (m.import_hc_kwh || 0) + (m.import_hp_kwh || 0);
  // Même règle que le graphe du dessus : la décimale apparaît quand l'échelle
  // descend (une journée, une heure), sinon tout s'affiche « 0 ».
  const fine = $derived(maxMonth > 0 && maxMonth < 10);
  const fmtVal = (v: number) => (fine ? nf1.format(v) : nf0.format(v));

  // Même règle de lisibilité que le graphe du dessus (cf. MonthlyEnergyChart).
  const dense = $derived(data.length > 16);
  const tickStep = $derived(data.length > 26 ? 5 : data.length > 16 ? 3 : 1);
  const isTick = (i: number) => i % tickStep === 0 || i === data.length - 1;
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

  // Hauteur de segment en px sur l'échelle commune (piste 120 px, comme le graphe
  // Saisons) ; un flux réel mais minuscule reste visible (plancher 2 px).
  const H = 170;
  const segH = (v: number) => (maxMonth > 0 && v > 0 ? Math.max((H * v) / maxMonth, 2) : 0);

  // Mois dont la VENTILATION est estimée : 'local' (total ET répartition mesure
  // maison) ou 'enedis' (total = compteur Linky, répartition encore estimée).
  const isEst = (m: Bucket) =>
    (m.import_split_source === 'local' || m.import_split_source === 'enedis') && monthTotal(m) > 0;
  const isEnedis = (m: Bucket) => m.import_split_source === 'enedis' && monthTotal(m) > 0;
</script>

<!-- Pas d'enveloppe ici : les deux graphes du bilan partagent UNE carte, montée
     par la page — leurs colonnes s'alignent alors verticalement et se lisent
     ensemble (un mois, sa consommation au-dessus, sa répartition en dessous). -->
<div
  class="flex flex-col gap-4"
  aria-label="Répartition Heures Creuses / Heures Pleines des imports réseau"
>
  {#if data.length > 0}
    <!-- Barres par mois : hauteur = part HC/HP, largeur = volume (cf. segH/colW).
         Toujours dessinées, même sans ventilation : une année ancienne garde ses
         12 pistes — pointillé avant le plancher des 24 mois d'Enedis, vide après
         (courbe jamais publiée ou relevé absent). -->
    <div
      class="bars"
      class:dense
      style="--n: {data.length}; --gap: {data.length > 20 ? 2 : 6}px;"
      role="img"
      aria-label="Part Heures Creuses / Pleines par mois — barre d'autant plus large que le mois a consommé"
    >
      {#each data as m, i (i)}
        {@const tot = monthTotal(m)}
        {@const est = isEst(m)}
        {@const gone = isUnreachable(m)}
        {@const canOpen = tot > 0 && !!m.key && !!onOpen}
        <svelte:element
          this={canOpen ? 'button' : 'div'}
          role={canOpen ? 'button' : undefined}
          tabindex={canOpen ? 0 : undefined}
          onclick={canOpen ? () => onOpen?.(m.key as string) : undefined}
          class="col"
          class:clickable={canOpen}
          title={tot > 0
            ? `${m.label} — Creuses ${nf1.format(m.import_hc_kwh)} kWh (${pct(
                m.import_hc_kwh,
                tot
              )} %) · Pleines ${nf1.format(m.import_hp_kwh)} kWh (${pct(m.import_hp_kwh, tot)} %)${
                isEnedis(m)
                  ? ' · total compteur EDF, répartition estimée'
                  : est
                    ? ' · estimé (mesure maison)'
                    : ''
              }`
            : gone
              ? `${m.label} — avant le ${floorLabel} : hors des 24 mois de courbe conservés par Enedis`
              : `${m.label} — pas de relevé`}
        >
          <span class="col-val">{tot >= (fine ? 0.05 : 0.5) ? fmtVal(tot) : ''}</span>
          <div class="track" class:filled={tot > 0} class:unreachable={gone}>
            <div class="seg seg-hp" style="height: {segH(m.import_hp_kwh)}px;"></div>
            <div class="seg seg-hc" style="height: {segH(m.import_hc_kwh)}px;"></div>
          </div>
        </svelte:element>
      {/each}
    </div>

    {#if hasData}
      <!-- Proportion globale, SOUS son graphique : on lit d'abord le détail
           mois par mois, la synthèse vient ensuite. -->
      <div class="flex flex-col gap-1.5">
        <!-- Cette ligne EST le titre du graphe du dessus : elle le nomme et le
             chiffre d'un coup, dans les couleurs des barres. -->
        <div class="flex items-center justify-between text-[13px] font-semibold">
          <span style="color: var(--color-hc);">Heures Creuses {pctHc} %</span>
          <span style="color: var(--color-hp);">Heures Pleines {pctHp} %</span>
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
    {:else if pending}
      <p class="text-[11px]" style="color: var(--color-muted-fg);">
        Relevés Heures Creuses / Pleines de {periode.toLowerCase()} en cours de récupération chez Enedis.
      </p>
    {/if}
    {#if anyUnreachable}
      <!-- Légende du pointillé, une ligne : sans elle, une piste vide et une
           piste hors de portée se ressembleraient. -->
      <p class="text-[10px]" style="color: var(--color-muted-fg);">
        Pointillé : avant le {floorLabel}, hors des 24 mois de courbe de charge conservés par
        Enedis.
      </p>
    {/if}
  {/if}
</div>

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
    /* Autant de colonnes que de tranches : 12 mois, 28 à 31 jours, ou 24 heures.
       minmax(0,1fr) est indispensable — sans lui, une colonne au contenu large
       (l'étiquette « 31 ») force un débordement au lieu de se comprimer. */
    grid-template-columns: repeat(var(--n, 12), minmax(0, 1fr));
    gap: 2px;
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
    color: inherit;
  }
  .col.clickable {
    cursor: pointer;
  }
  .col-val {
    min-height: 9px;
    font-size: 8px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted-fg);
  }
  /* Piste : largeur CONSTANTE, barre empilée HP (haut) + HC (bas) ancrée en
     bas, hauteur ∝ import du mois sur l'échelle commune avec le graphe Saisons. */
  .track {
    display: flex;
    width: 100%;
    height: 170px;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    border-radius: 5px;
    background: var(--color-muted);
  }
  .track.filled .seg:first-child {
    border-radius: 5px 5px 0 0;
  }
  /* Placeholder : tranche hors des 24 mois de courbe conservés par Enedis — la
     mesure n'existera jamais, la piste le dit d'un pointillé (≠ piste pleine
     « vide », qui attend un relevé ou n'en a pas eu). */
  .track.unreachable {
    background: transparent;
    border: 1.5px dashed var(--color-border);
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
  /* Écran étroit + beaucoup de colonnes : cf. MonthlyEnergyChart. */
  @media (max-width: 639px) {
    .bars.dense :global(.col-val) {
      display: none;
    }
  }
</style>
