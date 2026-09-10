<script lang="ts">
  /**
   * Tableau de bord de BUREAU — les quatre écrans de pilotage sur un seul.
   *
   * C'est CE QU'EST L'ACCUEIL sur un poste de travail (cf. src/routes/+page.svelte) :
   * pas une page à aller chercher. Sur un 27" 2K, l'app n'occupait que 1 280 px
   * de large et l'accueil s'arrêtait à mi-hauteur — mille pixels de dalle perdus
   * à droite, et quatre onglets à visiter pour voir la maison.
   *
   * Aucun contenu n'est réécrit : ce sont les MÊMES composants que /, /climat et
   * /pieces, montés avec `layout="column"` (leurs grilles internes se déplient
   * sinon sur la largeur du viewport, pas sur celle de la colonne). Seule la
   * musique a un panneau propre — la bibliothèque ne rentre pas dans 434 px et
   * n'a rien à faire sur un tableau de bord : elle reste sur /musique.
   *
   * Largeurs taillées sur le contenu, pas à parts égales : le Sankey est carré
   * (il commande sa colonne), les sept volets ont besoin de 80 px chacun pour
   * garder leurs boutons de 44 px. Repli en deux colonnes sous 2 200 px, en une
   * seule sous 1 500 px — la page reste lisible sur un portable.
   */
  import HomeEnergyPanel from '$components/panels/HomeEnergyPanel.svelte';
  import ClimatePanel from '$components/panels/ClimatePanel.svelte';
  import RoomsPanel from '$components/panels/RoomsPanel.svelte';
  import MusicQuickPanel from '$components/panels/MusicQuickPanel.svelte';

  const COLS = [
    { key: 'energie', title: 'Énergie', icon: 'M13 2 L4 14 H11 L9 22 L20 8 H13 Z' },
    {
      key: 'climat',
      title: 'Climat',
      icon: 'M12 2 C12 2 8 6 8 12 C8 16 10 19 12 19 C14 19 16 16 16 12 C16 8 14 6 14 6 C14 8 13 10 12 10 C11 10 12 6 12 2 Z'
    },
    {
      key: 'pieces',
      title: 'Pièces',
      icon: 'M3 3 H10 V10 H3 Z M14 3 H21 V10 H14 Z M3 14 H10 V21 H3 Z M14 14 H21 V21 H14 Z'
    },
    {
      key: 'ambiance',
      title: 'Ambiance',
      icon: 'M9 18 V5 L21 3 V16 M9 18 A3 3 0 1 1 3 18 A3 3 0 1 1 9 18 M21 16 A3 3 0 1 1 15 16 A3 3 0 1 1 21 16'
    }
  ] as const;
</script>

<div class="bureau">
  {#each COLS as col (col.key)}
    <section class="col" aria-label={col.title}>
      <h2 class="col-head">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={col.icon} />
        </svg>
        {col.title}
      </h2>

      {#if col.key === 'energie'}
        <HomeEnergyPanel layout="column" />
      {:else if col.key === 'climat'}
        <ClimatePanel layout="column" />
      {:else if col.key === 'pieces'}
        <RoomsPanel layout="column" />
      {:else}
        <MusicQuickPanel />
      {/if}
    </section>
  {/each}
</div>

<style>
  .bureau {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    align-items: start;
    padding: 8px 0 12px;
  }
  /* Portable / iPad paysage : deux colonnes. */
  @media (min-width: 1500px) {
    .bureau {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  /* Écran de bureau : les quatre colonnes, largeurs proportionnelles au contenu
     (Sankey carré ‖ climat ‖ volets à sept curseurs ‖ ambiance). */
  @media (min-width: 2200px) {
    .bureau {
      grid-template-columns: minmax(0, 590fr) minmax(0, 615fr) minmax(0, 565fr) minmax(0, 434fr);
    }
  }
  .col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 10px;
  }
  .col-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
</style>
