<script lang="ts">
  /**
   * Rubrique « Apparence » — thème et animations. Les préférences sont persistées
   * localement et hydratées app-wide par +layout.svelte ; on ré-hydrate ici par
   * sûreté en cas d'entrée directe par lien profond.
   */
  import { onMount } from 'svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { haptic } from '$utils/haptic';

  onMount(() => {
    preferences.hydrate();
  });
</script>

<section class="ios-section">
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Thème</span>
      <span class="ios-segmented" role="group" aria-label="Thème">
        {#each [{ v: 'light', l: 'Clair' }, { v: 'dark', l: 'Sombre' }] as opt (opt.v)}
          {@const active = preferences.theme === opt.v && !preferences.autoTheme}
          <button
            type="button"
            class="ios-segment"
            aria-pressed={active}
            onclick={() => {
              haptic('light');
              preferences.setTheme(opt.v as 'light' | 'dark');
            }}
          >
            {opt.l}
          </button>
        {/each}
      </span>
    </div>

    <div class="ios-cell">
      <span class="ios-cell-text">
        <span class="ios-cell-label">Automatique</span>
        <span class="ios-cell-sub">Clair 7 h–19 h, sombre 19 h–7 h</span>
      </span>
      <label class="ios-switch">
        <input
          type="checkbox"
          checked={preferences.autoTheme}
          aria-label="Bascule automatique du thème"
          onchange={(e) => {
            haptic('light');
            preferences.setAutoTheme((e.target as HTMLInputElement).checked);
          }}
        />
        <span class="ios-switch-track"></span>
      </label>
    </div>
  </div>
  <p class="ios-group-footer">
    En automatique, le thème suit l'heure et le choix Clair / Sombre est ignoré.
  </p>
</section>

<section class="ios-section">
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Animations</span>
      <label class="ios-switch">
        <input
          type="checkbox"
          checked={preferences.animationsEnabled}
          aria-label="Animations"
          onchange={(e) => {
            haptic('light');
            preferences.setAnimationsEnabled((e.target as HTMLInputElement).checked);
          }}
        />
        <span class="ios-switch-track"></span>
      </label>
    </div>
  </div>
  <p class="ios-group-footer">
    Désactiver économise la batterie. Les effets suivent de toute façon le réglage « Réduire les
    animations » d'iOS, même si l'interrupteur ci-dessus est activé.
  </p>
</section>
