<script lang="ts">
  /**
   * Réglage des enchaînements du lecteur — feuille ouverte depuis le Now
   * Playing (c'est là qu'on écoute, comme le panneau Lumière).
   *
   * Quatre réglages, façon PlexAmp :
   *   - durée du fondu enchaîné (0 = enchaînement sec, comportement historique) ;
   *   - fondu INTELLIGENT : la durée réelle se cale sur l'analyse de sonie du
   *     PMS — fin en fade-out → fondu ample, fin sèche → enchaînement court,
   *     silence d'intro sauté ;
   *   - volume nivelé : gain d'analyse appliqué à chaque piste, un album 2024
   *     ne hurle plus après un vinyle 70's ;
   *   - DJ automatique (Auto Play PlexAmp) : quand la file se termine, la
   *     station « Radio de la maison » du PMS prend le relais.
   *
   * Les changements sont persistés (preferences) et pris en compte au prochain
   * enchaînement ; le nivellement s'applique immédiatement à la piste en cours.
   */
  import { preferences } from '$stores/preferences.svelte';
  import { player } from '$stores/plex.svelte';
  import { haptic } from '$utils/haptic';

  const fadeLabel = $derived(
    preferences.musicFadeSeconds <= 0 ? 'Désactivé' : `${preferences.musicFadeSeconds} s`
  );
</script>

<div class="fp">
  <div class="fp-row">
    <span class="fp-text">
      <span class="fp-label">Durée du fondu</span>
      <span class="fp-sub">Chevauchement entre deux morceaux</span>
    </span>
    <span class="fp-value" class:off={preferences.musicFadeSeconds <= 0}>{fadeLabel}</span>
  </div>
  <input
    class="fp-slider"
    type="range"
    min="0"
    max="12"
    step="1"
    value={preferences.musicFadeSeconds}
    aria-label="Durée du fondu enchaîné (secondes)"
    oninput={(e) => preferences.setMusicFadeSeconds(Number(e.currentTarget.value))}
    onchange={() => {
      haptic('light');
      player.settingsChanged();
    }}
  />

  <div class="fp-row">
    <span class="fp-text">
      <span class="fp-label">Fondu intelligent</span>
      <span class="fp-sub">
        Calé sur l'analyse sonore Plex : fin douce → fondu complet, fin sèche → enchaînement court,
        silence d'intro sauté
      </span>
    </span>
    <label class="toggle-pill" aria-label="Fondu intelligent">
      <input
        type="checkbox"
        checked={preferences.musicSmartFades}
        disabled={preferences.musicFadeSeconds <= 0}
        onchange={(e) => {
          haptic('light');
          preferences.setMusicSmartFades((e.currentTarget as HTMLInputElement).checked);
          player.settingsChanged();
        }}
      />
      <span class="toggle-pill-knob"></span>
    </label>
  </div>

  <div class="fp-row">
    <span class="fp-text">
      <span class="fp-label">Volume nivelé</span>
      <span class="fp-sub">Égalise le volume perçu d'un morceau à l'autre (mesure Plex)</span>
    </span>
    <label class="toggle-pill" aria-label="Volume nivelé">
      <input
        type="checkbox"
        checked={preferences.musicLoudnessLeveling}
        onchange={(e) => {
          haptic('light');
          preferences.setMusicLoudnessLeveling((e.currentTarget as HTMLInputElement).checked);
          player.settingsChanged();
        }}
      />
      <span class="toggle-pill-knob"></span>
    </label>
  </div>

  <div class="fp-row">
    <span class="fp-text">
      <span class="fp-label">DJ automatique</span>
      <span class="fp-sub">
        La file ne s'arrête plus : quand elle se termine, le DJ enchaîne avec d'autres morceaux de
        la maison, choisis d'après vos écoutes
      </span>
    </span>
    <label class="toggle-pill" aria-label="DJ automatique">
      <input
        type="checkbox"
        checked={preferences.musicAutoDj}
        onchange={(e) => {
          haptic('light');
          preferences.setMusicAutoDj((e.currentTarget as HTMLInputElement).checked);
        }}
      />
      <span class="toggle-pill-knob"></span>
    </label>
  </div>

  {#if player.wirelessOutput}
    <p class="fp-hint">
      Lecture sur un autre appareil (AirPlay…) : les fondus sont mis en pause, les morceaux
      s'enchaînent sans chevauchement.
    </p>
  {/if}
</div>

<style>
  .fp {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .fp-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .fp-text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .fp-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .fp-sub {
    font-size: 12px;
    line-height: 1.4;
    color: var(--color-muted-fg);
  }
  .fp-value {
    font-size: 13px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-primary);
  }
  .fp-value.off {
    color: var(--color-muted-fg);
    font-weight: 600;
  }
  .fp-hint {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--color-muted-fg);
  }

  /* ─── Curseur ─── */
  .fp-slider {
    width: 100%;
    height: 28px;
    margin: -6px 0 0;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .fp-slider::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .fp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 22px;
    height: 22px;
    margin-top: -8px;
    border-radius: 50%;
    border: none;
    background: oklch(0.99 0.004 286);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.3);
  }
  .fp-slider::-moz-range-track {
    height: 6px;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .fp-slider::-moz-range-thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    background: oklch(0.99 0.004 286);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.3);
  }
  .fp-slider:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ─── Interrupteur (toggle-pill iOS, 44×24 — même dessin que le panneau Lumière) ─── */
  .toggle-pill {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .toggle-pill input {
    position: absolute;
    inset: 0;
    z-index: 1;
    margin: 0;
    cursor: pointer;
    opacity: 0;
  }
  .toggle-pill input:disabled {
    cursor: default;
  }
  .toggle-pill-knob {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-default);
  }
  .toggle-pill input:disabled + .toggle-pill-knob {
    opacity: 0.45;
  }
  .toggle-pill-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.99 0.004 286);
    box-shadow: 0 1px 2px oklch(0.1 0.01 286 / 0.18);
    transition: transform var(--duration-normal) var(--ease-spring);
  }
  .toggle-pill input:checked + .toggle-pill-knob {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .toggle-pill input:checked + .toggle-pill-knob::after {
    transform: translateX(20px);
  }
  .toggle-pill input:focus-visible + .toggle-pill-knob {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-pill-knob,
    .toggle-pill-knob::after {
      transition: none;
    }
  }
</style>
