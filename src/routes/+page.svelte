<script lang="ts">
  /**
   * Accueil — l'écran d'énergie de la maison.
   *
   * Le contenu vit dans `HomeEnergyPanel` : il est monté ICI en pleine page, et
   * dans la colonne « Énergie » du tableau de bord de bureau (/bureau). Un seul
   * markup, deux mises en page — sans quoi les deux écrans divergeraient à la
   * première carte ajoutée.
   */
  import HomeEnergyPanel from '$components/panels/HomeEnergyPanel.svelte';
</script>

<HomeEnergyPanel />
