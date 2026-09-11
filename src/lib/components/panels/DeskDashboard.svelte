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
  /* Fenêtre de bureau étroite : deux colonnes. Seuil MESURÉ et non arrondi —
     la colonne « Pièces » ne descend pas sous 527 px (sept volets à 73 px plus
     les marges de la carte), soit 1 400 px de fenêtre une fois la barre
     latérale (240) et les marges (64) déduites. */
  @media (min-width: 1400px) {
    .bureau {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  /* Portable 2K mis à l'échelle 150 % : le navigateur n'y voit que 1 706 px, et
     quatre colonnes de 340 px ne seraient plus lisibles. Trois, oui — « Ambiance »
     passe alors sous « Énergie », la plus courte des trois (mesuré : 1 100 px
     contre 1 332 pour Climat et 1 201 pour Pièces), ce qui équilibre au mieux
     des panneaux insécables. */
  @media (min-width: 1600px) {
    .bureau {
      grid-template-columns: minmax(0, 590fr) minmax(0, 615fr) minmax(0, 565fr);
    }
  }
  /* Écran de bureau : les quatre colonnes, largeurs proportionnelles au contenu
     (Sankey carré ‖ climat ‖ volets à sept curseurs ‖ ambiance).
     Seuil à 1 900 px et non 2 200 : un portable 2K mis à l'échelle Windows à
     125 % ne présente que 2 048 px CSS au navigateur — il avait donc droit à
     deux colonnes et 1 700 px de défilement, là où le 27" à 100 % en affichait
     quatre. Les volets suivent maintenant la largeur de leur tuile (cf.
     RoomsPanel), ce qui rend ces largeurs tenables. */
  @media (min-width: 1900px) {
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
