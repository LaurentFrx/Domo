<script module lang="ts">
  /** Vues de la feuille — exportée pour que la carte ouvre directement la bonne. */
  export type WledTab = 'scenes' | 'couleur' | 'effet' | 'lignes';
</script>

<script lang="ts">
  /**
   * Feuille de réglage de l'éclairage terrasse — les SOUS-VUES de la carte.
   *
   * Pourquoi une feuille : tout ce contenu (8 ambiances, 24 styles musicaux, le
   * sélecteur de couleur, 100+ effets, le pilotage par ligne) vivait dépliable
   * DANS la carte, qui atteignait plusieurs écrans de haut sur iPhone. La carte
   * ne garde désormais que ce qu'on touche en passant ; le reste s'ouvre ici,
   * en plein écran, avec de vraies cibles tactiles — le geste des applications
   * d'éclairage de référence (Hue, Nanoleaf, l'app WLED elle-même).
   *
   * UNE décision à la fois : un sélecteur segmenté en tête, une seule vue à
   * l'écran. On n'empile pas quatre panneaux ouverts.
   *
   * Les stores sont lus DIRECTEMENT (module-level) : rien à faire redescendre en
   * props, et la feuille reste synchrone avec la carte qui l'a ouverte.
   */
  import { wled, WLED_AMBIANCES, type WledSegment } from '$stores/wled.svelte';
  import { wledMusic, WLED_MUSIC_STYLES } from '$stores/wledMusic.svelte';
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import { haptic } from '$utils/haptic';

  let {
    open = false,
    tab = $bindable<WledTab>('scenes'),
    selectedId = 0,
    onClose
  }: {
    open?: boolean;
    tab?: WledTab;
    selectedId?: number;
    onClose: () => void;
  } = $props();

  let showAllFx = $state(false);
  let fxQuery = $state('');

  const isTogether = $derived(wled.scope === 'together');
  const target = $derived(
    isTogether
      ? (wled.segments[0] ?? null)
      : (wled.segments.find((s) => s.id === selectedId) ?? wled.segments[0] ?? null)
  );
  const ctlDisabled = $derived(!wled.on);
  const effLoaded = $derived(wled.effects.length > 0);

  // Titre : dire SUR QUOI on agit. En pilotage séparé, le nom de la ligne ciblée
  // est la seule chose qui distingue deux ouvertures de la feuille.
  const title = $derived(
    !isTogether && target ? `Terrasse — ${target.name}` : 'Éclairage terrasse'
  );

  const TABS: { key: WledTab; label: string }[] = [
    { key: 'scenes', label: 'Scènes' },
    { key: 'couleur', label: 'Couleur' },
    { key: 'effet', label: 'Effet' },
    { key: 'lignes', label: 'Lignes' }
  ];

  // ─── Effets curés (terrasse) : libellés FR → premier nom WLED présent ───
  const CURATED_FX: { label: string; names: string[] }[] = [
    { label: 'Fixe', names: ['Solid'] },
    { label: 'Respiration', names: ['Breathe'] },
    { label: 'Bougie', names: ['Candle', 'Candle Multi'] },
    { label: 'Feu', names: ['Fire 2012', 'Fire Flicker'] },
    { label: 'Scintillement', names: ['Twinklefox', 'Twinkle'] },
    { label: 'Arc-en-ciel', names: ['Rainbow'] },
    { label: 'Vagues', names: ['Colorwaves', 'Colorloop'] },
    { label: 'Poursuite', names: ['Running', 'Chase'] },
    { label: 'Balayage', names: ['Scanner', 'Scan'] },
    { label: 'Comète', names: ['Multi Comet', 'Meteor'] },
    { label: 'Aurore', names: ['Aurora'] },
    { label: 'Océan', names: ['Pacifica', 'Lake'] }
  ];
  const curatedFx = $derived(
    CURATED_FX.map((c) => {
      const idx = c.names.map((n) => wled.effects.indexOf(n)).find((i) => i >= 0) ?? -1;
      return { label: c.label, idx };
    }).filter((c) => c.idx >= 0)
  );
  const fxFiltered = $derived.by(() => {
    const q = fxQuery.trim().toLowerCase();
    return wled.effects
      .map((name, i) => ({ name, i }))
      .filter((e) => !q || e.name.toLowerCase().includes(q));
  });

  /** Un réglage manuel reprend la main sur le suivi musique. */
  function manual(): void {
    wledMusic.releaseControl();
  }
</script>

<BottomSheet {open} {title} {onClose}>
  <!-- Sélecteur de vue : segmenté iOS, une seule vue affichée à la fois. -->
  <div class="seg" role="tablist" aria-label="Que voulez-vous régler ?">
    {#each TABS as t (t.key)}
      <button
        type="button"
        class="seg-item"
        class:active={tab === t.key}
        role="tab"
        aria-selected={tab === t.key}
        onclick={() => {
          haptic('light');
          tab = t.key;
        }}
      >
        {t.label}
      </button>
    {/each}
  </div>

  {#if tab === 'scenes'}
    <!-- ─── SCÈNES : vignettes larges (couleur + nom), puis la musique ─── -->
    <div class="tile-grid" role="group" aria-label="Ambiances">
      {#each WLED_AMBIANCES as a (a.key)}
        <button
          type="button"
          class="tile"
          class:tile-off={a.off}
          onclick={() => {
            haptic('medium');
            manual();
            wled.applyAmbiance(a.key);
          }}
        >
          <span
            class="tile-swatch"
            style={a.off ? '' : `background: ${a.swatch};`}
            aria-hidden="true"
          ></span>
          <span class="tile-label">{a.label}</span>
        </button>
      {/each}
    </div>

    <div class="music-head">
      <div class="flex min-w-0 flex-col">
        <span class="text-[14px] font-semibold" style="color: var(--color-fg);"
          >Suivre la musique</span
        >
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          Le ruban réagit à ce qui joue sur Domo
        </span>
      </div>
      <label class="toggle-pill" aria-label="Suivre la musique">
        <input
          type="checkbox"
          checked={wledMusic.enabled}
          onchange={(e) => {
            haptic('medium');
            wledMusic.setEnabled((e.currentTarget as HTMLInputElement).checked);
          }}
        />
        <span class="toggle-pill-knob"></span>
      </label>
    </div>

    {#if wledMusic.enabled}
      <!-- Un effet ♪ ne suit QUE le volume — c'est sa conception WLED : le dire
           évite de chercher des fréquences là où il n'y en aura jamais. -->
      <div role="radiogroup" aria-label="Style musical" class="flex flex-col gap-2">
        {#each [{ kind: 'freq', title: 'Réagit aux fréquences' }, { kind: 'vol', title: 'Réagit au volume' }] as grp (grp.kind)}
          <span class="group-title">{grp.title}</span>
          <div class="chip-grid">
            {#each WLED_MUSIC_STYLES.filter((s) => s.kind === grp.kind || (grp.kind === 'freq' && s.kind === 'ambiance')) as st (st.key)}
              <button
                type="button"
                class="chip"
                class:active={wledMusic.style === st.key}
                role="radio"
                aria-checked={wledMusic.style === st.key}
                title={st.hint}
                onclick={() => {
                  haptic('light');
                  wledMusic.setStyle(st.key);
                }}
              >
                {st.label}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  {:else if tab === 'couleur' && target}
    {@render colorView(target)}
  {:else if tab === 'effet' && target}
    {@render effectView(target)}
  {:else if tab === 'lignes'}
    {@render linesView()}
  {/if}
</BottomSheet>

{#snippet colorView(s: WledSegment)}
  <div class="flex flex-col gap-3" class:dimmed={ctlDisabled}>
    <WledColorPicker
      color={s.col}
      disabled={ctlDisabled}
      onpick={(rgb) => {
        manual();
        wled.setSegColor(s.id, rgb);
      }}
    />
    {#if wled.rgbw}
      <div class="slider-line">
        <span class="slider-label">Blanc 4000K</span>
        <input
          type="range"
          class="range"
          min="0"
          max="255"
          value={s.white}
          disabled={ctlDisabled}
          oninput={(e) => {
            manual();
            wled.setSegWhite(s.id, +(e.currentTarget as HTMLInputElement).value);
          }}
          onchange={() => haptic('light')}
          aria-label="Canal blanc 4000K"
        />
        <span class="slider-pct tabular-nums">{Math.round((s.white / 255) * 100)}%</span>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet effectView(s: WledSegment)}
  {@const isSolid = !effLoaded || (wled.effects[s.fx] ?? 'Solid') === 'Solid'}
  <!-- Des noms simples + UNE vitesse. Le catalogue complet reste replié.
       (Choisir un effet remet ses couleurs par défaut : zéro « palette » à comprendre.) -->
  <div class="flex flex-col gap-3" class:dimmed={ctlDisabled}>
    <div class="chip-grid">
      {#each curatedFx as c (c.idx)}
        <button
          type="button"
          class="chip"
          class:active={s.fx === c.idx}
          aria-pressed={s.fx === c.idx}
          disabled={ctlDisabled}
          onclick={() => {
            manual();
            wled.setSegEffect(s.id, c.idx);
            wled.setSegPalette(s.id, 0);
          }}
        >
          {c.label}
        </button>
      {/each}
    </div>

    {#if effLoaded && !isSolid}
      <div class="slider-line">
        <span class="slider-label">Vitesse</span>
        <input
          type="range"
          class="range"
          min="0"
          max="255"
          value={s.sx}
          disabled={ctlDisabled}
          oninput={(e) => {
            manual();
            wled.setSegSpeed(s.id, +(e.currentTarget as HTMLInputElement).value);
          }}
          onchange={() => haptic('light')}
          aria-label="Vitesse de l'effet"
        />
      </div>
    {/if}

    <button
      type="button"
      class="disclosure"
      aria-expanded={showAllFx}
      onclick={() => (showAllFx = !showAllFx)}
    >
      <span>Tous les effets ({wled.effects.length})</span>
      <span class="chevron" class:open={showAllFx} aria-hidden="true">⌄</span>
    </button>
    {#if showAllFx}
      <input
        type="search"
        class="search"
        placeholder="Rechercher un effet…"
        bind:value={fxQuery}
        disabled={ctlDisabled}
        aria-label="Rechercher un effet"
      />
      <div class="chip-grid" role="listbox" aria-label="Tous les effets">
        {#each fxFiltered as e (e.i)}
          <button
            type="button"
            class="chip"
            class:active={s.fx === e.i}
            role="option"
            aria-selected={s.fx === e.i}
            disabled={ctlDisabled}
            onclick={() => {
              manual();
              wled.setSegEffect(s.id, e.i);
            }}
          >
            {e.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet linesView()}
  <div class="flex flex-col gap-3">
    <button
      type="button"
      class="scope-toggle"
      onclick={() => {
        haptic('light');
        wled.setScope(isTogether ? 'perLine' : 'together');
      }}
    >
      {isTogether ? 'Régler les lignes séparément' : 'Piloter toutes les lignes ensemble'}
    </button>

    {#if !isTogether}
      <!-- Toutes les lignes, pas seulement la ciblée : dans cette vue on compare
           et on ajuste — obliger à ressortir pour changer de ligne serait absurde. -->
      {#each wled.segments as seg (seg.id)}
        <div class="line-card" class:dimmed={ctlDisabled}>
          <div class="flex items-center justify-between gap-3">
            <span class="text-[14px] font-semibold" style="color: var(--color-fg);">{seg.name}</span
            >
            <label class="toggle-pill" aria-label="Allumer / éteindre {seg.name}">
              <input
                type="checkbox"
                checked={seg.on}
                disabled={!wled.on}
                onchange={(e) => {
                  haptic('light');
                  wled.setSegOn(seg.id, (e.currentTarget as HTMLInputElement).checked);
                }}
              />
              <span class="toggle-pill-knob"></span>
            </label>
          </div>
          <div class="slider-line">
            <span class="slider-label">Luminosité</span>
            <input
              type="range"
              class="range"
              min="0"
              max="255"
              value={seg.bri}
              disabled={ctlDisabled || !seg.on}
              oninput={(e) => wled.setSegBri(seg.id, +(e.currentTarget as HTMLInputElement).value)}
              onchange={() => haptic('light')}
              aria-label="Luminosité {seg.name}"
            />
            <span class="slider-pct tabular-nums">{Math.round((seg.bri / 255) * 100)}%</span>
          </div>
        </div>
      {/each}
    {:else}
      <p class="text-[13px] leading-relaxed" style="color: var(--color-muted-fg);">
        Les {wled.segments.length} lignes suivent le même réglage. Passez en mode séparé pour leur donner
        chacune une couleur, un effet et une luminosité.
      </p>
    {/if}
  </div>
{/snippet}

<style>
  /* ─── Sélecteur segmenté (une décision à la fois) ─── */
  .seg {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
  }
  .seg-item {
    flex: 1 1 0;
    padding: 7px 4px;
    border: 0;
    border-radius: calc(var(--radius-lg) - 3px);
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .seg-item.active {
    background: var(--color-card-hover);
    color: var(--color-fg);
  }
  .seg-item:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  /* ─── Vignettes de scène : la couleur d'abord, le nom ensuite ─── */
  .tile-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  @media (min-width: 480px) {
    .tile-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .tile {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    min-height: 52px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .tile-swatch {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border-radius: 9999px;
    box-shadow: inset 0 0 0 1px oklch(1 0 0 / 0.25);
  }
  .tile-off .tile-swatch {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--color-muted-fg);
  }
  .tile-label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Bloc musique ─── */
  .music-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 4px;
    border-top: 1px solid var(--color-border);
    margin-top: 4px;
  }
  .group-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }

  /* ─── Pastilles (styles musicaux, effets) ─── */
  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 7px 11px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .chip.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .chip:disabled {
    opacity: 0.45;
  }

  /* ─── Curseurs ─── */
  .slider-line {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .slider-label {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }
  .slider-pct {
    flex: 0 0 auto;
    min-width: 2.5rem;
    text-align: right;
    font-size: 12px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .range {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    accent-color: var(--color-primary);
  }
  .dimmed {
    opacity: 0.45;
    pointer-events: none;
  }

  /* ─── Divers ─── */
  .disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 9px 2px;
    border: 0;
    background: transparent;
    color: var(--color-muted-fg);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .chevron {
    transition: transform var(--duration-fast) var(--ease-default);
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .search {
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 16px; /* ≥16px : pas de zoom iOS à la mise au point */
  }
  .scope-toggle {
    width: 100%;
    padding: 11px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
  }
  .line-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
  }

  /* ─── Interrupteur (toggle-pill iOS, 44×24) ─── */
  .toggle-pill {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    flex: 0 0 auto;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .toggle-pill input {
    position: absolute;
    inset: 0;
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 1;
  }
  .toggle-pill-knob {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-default);
  }
  .toggle-pill-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px oklch(0.1 0.01 286 / 0.15);
    transition: transform var(--duration-normal) var(--ease-spring);
  }
  .toggle-pill input:checked + .toggle-pill-knob {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .toggle-pill input:checked + .toggle-pill-knob::after {
    transform: translateX(20px);
  }
  .toggle-pill input:disabled + .toggle-pill-knob {
    opacity: 0.45;
  }
  .toggle-pill input:focus-visible + .toggle-pill-knob {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle-pill-knob,
    .toggle-pill-knob::after,
    .chevron {
      transition: none;
    }
  }
</style>
