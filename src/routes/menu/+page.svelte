<script lang="ts">
  /**
   * Index du menu — même liste que la feuille « ☰ », mais en page plein écran.
   * Sert de cible aux liens profonds (anciennes notifications /reglages, partage
   * d'URL, retour depuis une rubrique) et de repli si la feuille n'est pas
   * ouvrable (JS non hydraté). Le grand titre est porté par /menu/+layout.
   */
  import MenuList from '$components/layout/MenuList.svelte';
</script>

<MenuList />
