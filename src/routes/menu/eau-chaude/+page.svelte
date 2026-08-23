<script lang="ts">
  /**
   * Rubrique « Eau chaude ». Volontairement PAUVRE en réglages : les seuils fins
   * ont été supprimés en juillet 2026 (décision Laurent) — ils n'étaient lus par
   * aucun code de décision, et vider un champ persistait silencieusement la borne
   * basse. Le pilotage réel vit dans la config serveur ; le geste quotidien
   * (marche forcée, journal) est sur la carte « Eau chaude » de la page Énergie.
   */
  import { onMount, onDestroy } from 'svelte';
  import PlannerCard from '$components/cards/PlannerCard.svelte';
  import { cumulus } from '$stores/cumulus.svelte';
  import { acquireFns } from '$stores/refcount';

  // La carte « Eau chaude » vit ICI depuis le 23/08 (décision Laurent) — plus
  // sur /energie. Mêmes acquisitions refcountées que là-bas : relais Shelly +
  // orchestrateur (mode, décision, énergie, journal). em50 est app-wide (layout).
  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [
      acquireFns(
        'cumulus:relay',
        () => cumulus.connectRelay(),
        () => cumulus.disconnectRelay()
      ),
      acquireFns(
        'cumulus:orchestrator',
        () => cumulus.connectOrchestrator(),
        () => cumulus.disconnectOrchestrator()
      )
    ];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });
</script>

<!-- La carte garde le langage visuel de l'app (verre Yeldra) sur la surface
     Réglages : c'est un écran de pilotage, pas une liste de préférences. -->
<section class="ios-section">
  <PlannerCard />
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
