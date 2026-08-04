<script lang="ts">
  /**
   * Rubrique « Chauffage salle de bain » — réglages du daemon TPI qui pilote le
   * sèche-serviette (presets, coefficients, sécurités) + accès au planning
   * d'Isabelle dont dérive l'heure de chauffe.
   *
   * Les modifications sont poussées AU DAEMON en direct (thermostat.pushConfig) en
   * plus d'être écrites dans settings.json : sans ça, une valeur enregistrée ne
   * s'appliquerait qu'au prochain redémarrage du daemon.
   */
  import { onMount, onDestroy } from 'svelte';
  import { settings } from '$stores/settings.svelte';
  import { thermostat } from '$stores/thermostat.svelte';
  import { acquire } from '$stores/refcount';
  import { haptic } from '$utils/haptic';

  let releases: (() => void)[] = [];
  onMount(() => {
    settings.hydrate();
    releases = [acquire(thermostat)];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });

  function save() {
    haptic('success');
    settings.save();
    thermostat.pushConfig(settings.thermostat);
  }
</script>

<section class="ios-section">
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Thermostat</span>
      <span
        class="ios-cell-value"
        class:is-green={thermostat.connected}
        class:is-red={!thermostat.connected}
      >
        {thermostat.connected ? 'En ligne' : 'Hors ligne'}
      </span>
    </div>
  </div>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Températures</h2>
  <div class="ios-group">
    <label class="ios-cell">
      <span class="ios-cell-label">Hors-gel</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.presetTemps.frost}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Éco</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.presetTemps.eco}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Confort</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.presetTemps.comfort}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Boost</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.presetTemps.boost}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
  </div>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Régulation</h2>
  <div class="ios-group">
    <label class="ios-cell">
      <span class="ios-cell-label">Coefficient intérieur</span>
      <input
        type="number"
        class="ios-input"
        step="0.05"
        bind:value={settings.thermostat.coefInt}
        onchange={save}
      />
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Coefficient extérieur</span>
      <input
        type="number"
        class="ios-input"
        step="0.005"
        bind:value={settings.thermostat.coefExt}
        onchange={save}
      />
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Durée de cycle</span>
      <input
        type="number"
        class="ios-input"
        step="30"
        bind:value={settings.thermostat.cycleSec}
        onchange={save}
      />
      <span class="ios-cell-value">s</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Durée du boost</span>
      <input
        type="number"
        class="ios-input"
        step="5"
        bind:value={settings.thermostat.boostDefaultMin}
        onchange={save}
      />
      <span class="ios-cell-value">min</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Pré-chauffe</span>
      <input
        type="number"
        class="ios-input"
        step="5"
        bind:value={settings.thermostat.preheatMin}
        onchange={save}
      />
      <span class="ios-cell-value">min</span>
    </label>
  </div>
  <p class="ios-group-footer">
    Puissance de chauffe = coefficient intérieur × (cible − pièce) + coefficient extérieur × (cible
    − extérieur), appliquée par cycles. Toute modification part au thermostat immédiatement.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Sécurité</h2>
  <div class="ios-group">
    <label class="ios-cell">
      <span class="ios-cell-label">Température minimale</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.minTempC}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Température maximale</span>
      <input
        type="number"
        class="ios-input"
        step="0.5"
        bind:value={settings.thermostat.maxTempC}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">Chute « fenêtre ouverte »</span>
      <input
        type="number"
        class="ios-input"
        step="0.1"
        bind:value={settings.thermostat.windowDropC}
        onchange={save}
      />
      <span class="ios-cell-value">°C</span>
    </label>
    <label class="ios-cell">
      <span class="ios-cell-label">…sur une durée de</span>
      <input
        type="number"
        class="ios-input"
        step="1"
        bind:value={settings.thermostat.windowDropMin}
        onchange={save}
      />
      <span class="ios-cell-value">min</span>
    </label>
  </div>
  <p class="ios-group-footer">
    Une chute plus rapide que ce seuil est interprétée comme une fenêtre ouverte : la chauffe
    s'interrompt le temps que la température remonte.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Occupation</h2>
  <div class="ios-group">
    <!-- Hors /menu à dessein : « Mes matins » est l'écran d'Isabelle, il garde le
         langage familier de l'app plutôt que la surface Réglages. -->
    <a href="/planning" class="ios-cell" data-sveltekit-preload-data>
      <span class="ios-cell-text">
        <span class="ios-cell-label">Planning d'Isabelle</span>
        <span class="ios-cell-sub">Heure du premier cours, jour par jour</span>
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
    La salle de bain est chauffée pour le réveil, déduit du premier cours (réveil = premier cours −
    1 h 30).
  </p>
</section>
