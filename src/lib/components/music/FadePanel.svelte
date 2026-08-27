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
   *   - DJ automatique (Auto Play PlexAmp) : quand la file se termine, le DJ
   *     choisi prend le relais — Guest DJ contextuel (Twofer/Contempo/Groupie)
   *     ou station du PMS.
   *
   * Les changements sont persistés (preferences) et pris en compte au prochain
   * enchaînement ; le nivellement s'applique immédiatement à la piste en cours.
   */
  import { preferences } from '$stores/preferences.svelte';
  import { player, RADIO_STATIONS } from '$stores/plex.svelte';
  import { haptic } from '$utils/haptic';

  const fadeLabel = $derived(
    preferences.musicFadeSeconds <= 0 ? 'Désactivé' : `${preferences.musicFadeSeconds} s`
  );

  /** Guest DJ façon PlexAmp — les trois que le serveur sait servir (les DJ à
   *  similarité sonore, Stretch/Gemini/Freeze, demandent l'analyse sonique que
   *  le PMS du Raspberry Pi ne produit pas ; PlexAmp les grise aussi). */
  const GUEST_DJS = [
    {
      id: 'twofer',
      label: 'DJ Twofer',
      desc: 'Insère un autre titre du même artiste après chaque titre'
    },
    {
      id: 'contempo',
      label: 'DJ Contempo',
      desc: 'Prolonge l’ambiance avec des titres de la même époque'
    },
    {
      id: 'groupie',
      label: 'DJ Groupie',
      desc: 'Continue d’ajouter des titres du même artiste dans la file'
    }
  ];

  function pickDj(id: string) {
    haptic('light');
    preferences.setMusicDj(id);
    player.djSourceChanged();
  }

  /** Description du DJ sélectionné (légende sous les pastilles). */
  const djDesc = $derived.by(() => {
    const guest = GUEST_DJS.find((d) => d.id === preferences.musicDj);
    if (guest) return guest.desc;
    const st = RADIO_STATIONS.find((s) => `station:${s.id}` === preferences.musicDj);
    return st ? st.desc : RADIO_STATIONS[0].desc;
  });
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
        La file ne s'arrête plus : quand elle se termine, le DJ choisi ci-dessous prend le relais
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

  {#if preferences.musicAutoDj}
    <!-- Type de DJ : Guest DJ (contextuels, façon PlexAmp) ou station du
         serveur. Le choix vaut pour la suite — ce qui est déjà dans la file y reste. -->
    <div role="radiogroup" aria-label="Type de DJ" class="fp-dj">
      <span class="fp-group">DJ invités</span>
      <div class="fp-chips fp-chips-3">
        {#each GUEST_DJS as dj (dj.id)}
          <button
            type="button"
            class="fp-chip"
            class:active={preferences.musicDj === dj.id}
            role="radio"
            aria-checked={preferences.musicDj === dj.id}
            onclick={() => pickDj(dj.id)}
          >
            {dj.label}
          </button>
        {/each}
      </div>
      <span class="fp-group">Stations</span>
      <div class="fp-chips">
        {#each RADIO_STATIONS as st (st.id)}
          <button
            type="button"
            class="fp-chip"
            class:active={preferences.musicDj === `station:${st.id}`}
            role="radio"
            aria-checked={preferences.musicDj === `station:${st.id}`}
            onclick={() => pickDj(`station:${st.id}`)}
          >
            {st.label}
          </button>
        {/each}
      </div>
      <p class="fp-hint">{djDesc}</p>
      <p class="fp-hint fp-dim">
        Comme dans PlexAmp, les DJ à similarité sonore (Stretch, Gemini, Freeze) restent
        indisponibles : ils demandent l'analyse sonique, que le serveur ne peut pas produire.
      </p>
    </div>
  {/if}

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

  /* ─── Type de DJ (chips, même dessin que le panneau Lumière) ─── */
  .fp-dj {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: -4px;
  }
  .fp-group {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .fp-dim {
    opacity: 0.75;
  }
  .fp-chips {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .fp-chips-3 {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .fp-chip {
    /* Cible tactile ≥ 44 pt (HIG). */
    min-height: 44px;
    padding: 7px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.25;
    cursor: pointer;
  }
  .fp-chip.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .fp-chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
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
