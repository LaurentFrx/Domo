<script lang="ts">
  /**
   * Accueil — ce que montre la maison quand on ouvre Domo.
   *
   * Sur iPhone et iPad : l'écran d'énergie (`HomeEnergyPanel`), et les autres
   * pages au bout d'un onglet ou d'un balayage.
   * Sur un poste de travail : le tableau de bord à quatre colonnes, qui porte
   * les quatre écrans de pilotage d'un coup — il y a la place, la chercher
   * derrière une adresse spéciale n'aurait servi à rien.
   *
   * Le choix se fait au MONTAGE (cf. `desk`) et non en CSS : afficher l'un en
   * masquant l'autre monterait Climat, Pièces et Musique — donc leur polling —
   * sur un téléphone.
   */
  import { desk } from '$stores/desk.svelte';
  import HomeEnergyPanel from '$components/panels/HomeEnergyPanel.svelte';
  import DeskDashboard from '$components/panels/DeskDashboard.svelte';
</script>

{#if desk.is}
  <DeskDashboard />
{:else}
  <HomeEnergyPanel />
{/if}
