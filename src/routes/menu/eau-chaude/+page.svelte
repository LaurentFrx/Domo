<script lang="ts">
  /**
   * Rubrique « Eau chaude ». Volontairement PAUVRE en réglages : les seuils fins
   * ont été supprimés en juillet 2026 (décision Laurent) — ils n'étaient lus par
   * aucun code de décision, et vider un champ persistait silencieusement la borne
   * basse. Le pilotage réel vit dans la config serveur ; le geste quotidien
   * (marche forcée, journal) est sur la carte « Eau chaude » de la page Énergie.
   */
  import { onMount } from 'svelte';
  import { cumulus } from '$stores/cumulus.svelte';

  onMount(() => {
    cumulus.refreshOrchestrator(); // état du moteur (one-shot, sans polling)
  });
</script>

<section class="ios-section">
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Pilotage automatique</span>
      <span class="ios-cell-value is-green">Actif</span>
    </div>
  </div>
  <p class="ios-group-footer">
    Le chauffe-eau chauffe au soleil quand il y a du surplus, et complète la nuit en heures creuses
    si la réserve d'eau chaude ne suffit pas. Il ne fait jamais acheter d'électricité au réseau pour
    chauffer. Rien à régler ici : la marche forcée et le journal du jour sont sur la carte « Eau
    chaude » de la page Énergie.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Observation</h2>
  <div class="ios-group">
    <a href="/cumulus-labo" class="ios-cell" data-sveltekit-preload-data>
      <span class="ios-cell-text">
        <span class="ios-cell-label">Labo — modèle shadow</span>
        <span class="ios-cell-sub">Ne pilote rien, observe seulement</span>
      </span>
      <svg
        class="ios-chevron"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M9 5l7 7-7 7" />
      </svg>
    </a>
  </div>
  <p class="ios-group-footer">
    Ce que le modèle mathématique « aurait » décidé, tick par tick — pour comparer au réel avant
    toute décision.
  </p>
</section>
