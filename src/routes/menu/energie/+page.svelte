<script lang="ts">
  /**
   * Rubrique « Automatismes » — les boucles de fond qui pilotent l'installation
   * toutes seules, retirées de /energie (2026-08-03).
   *
   * Pourquoi ici : ce sont des automatismes qu'on règle une fois puis qu'on
   * surveille de loin. Les cartes elles-mêmes sont reprises À L'IDENTIQUE — elles
   * pilotent du réel (écritures cloud Solix, bridage de l'onduleur), on ne les
   * réécrit pas pour une question de rangement. La surface iOS les aplatit depuis
   * le thème (cf. app.css, html[data-surface='ios']).
   */
  import { onMount, onDestroy } from 'svelte';
  import { acquire } from '$stores/refcount';
  import { sb3loop } from '$stores/sb3loop.svelte';
  import { apsloop } from '$stores/apsloop.svelte';
  import AnkerLocalCard from '$components/cards/AnkerLocalCard.svelte';
  import Sb3LoopCard from '$components/cards/Sb3LoopCard.svelte';
  import ApsLoopCard from '$components/cards/ApsLoopCard.svelte';

  // Refcount : l'accueil acquiert aussi sb3loop (il lit la consigne fraîche pour
  // son bilan) — un connect/disconnect binaire couperait l'autre page.
  // ankerLocal (Modbus) est app-wide, piloté par +layout.svelte : ne pas l'acquérir.
  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [acquire(sb3loop), acquire(apsloop)];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });
</script>

<section class="ios-section">
  <h2 class="ios-group-header">Batteries · consigne cloud</h2>
  <Sb3LoopCard />
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Onduleur APsystems · anti-injection</h2>
  <ApsLoopCard />
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Mesure locale · Modbus</h2>
  <AnkerLocalCard />
  <p class="ios-group-footer">
    Ces trois boucles tournent en continu, même app fermée. Elles se coupent d'elles-mêmes si Domo
    s'arrête : les consignes envoyées au matériel expirent seules.
  </p>
</section>
