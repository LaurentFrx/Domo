<script lang="ts">
  /**
   * Carte de contrôle de l'éclairage terrasse (WLED — QuinLed Dig-Uno V3).
   *
   * Budget d'information STRICT — surface par défaut = 4 rangées :
   *   1. en-tête + interrupteur (badge seulement si anormal) ;
   *   2. HÉROS — la barre de lumière (WledPreview), animée par le niveau
   *      sonore serveur quand la musique joue (même donnée que le ruban) ;
   *   3. luminosité (une ligne compacte, un seul %) ;
   *   4. scènes : Musique + les 3 ambiances les plus utiles + « … » (le reste
   *      vit dans Personnaliser).
   * Musique active → UNE rangée de plus : les 6 styles sur une seule ligne
   * scrollable. Tout le reste (autres ambiances, couleur, effet, lignes
   * séparées) est replié dans « Personnaliser ».
   *
   * Le mode Musique est un état SERVEUR partagé (SSE /api/wled/music/live) :
   * la chip, les styles et la légende reflètent le ruban réel — plus jamais un
   * flag localStorage propre à l'appareil.
   */
  import { wled, WLED_AMBIANCES, type WledSegment } from '$stores/wled.svelte';
  import { wledMusic, WLED_MUSIC_STYLES } from '$stores/wledMusic.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import WledPreview from './WledPreview.svelte';
  import { haptic } from '$utils/haptic';

  let selectedId = $state(0);
  let showCustom = $state(false);
  let showAllFx = $state(false);
  let fxQuery = $state('');
  /** Rangée de scènes étendue (le « … » déplie SUR PLACE, pas de menu). */
  let moreScenes = $state(false);
  /** Vue active du panneau Réglages : UNE décision à la fois. */
  let customTab = $state<'couleur' | 'effet' | 'lignes'>('couleur');

  // Flux temps réel du mode Musique (état + niveau sonore) tant que la carte
  // est à l'écran — refcounté et suspendu en arrière-plan dans le store.
  $effect(() => {
    wledMusic.openLive();
    return () => wledMusic.closeLive();
  });

  // Scènes : les 3 plus utiles d'abord, le reste dépliable sur place via « … ».
  const SCENE_MAIN = ['blanc', 'warm', 'soiree'];
  const scenesMain = $derived(WLED_AMBIANCES.filter((a) => SCENE_MAIN.includes(a.key)));
  const scenesMore = $derived(WLED_AMBIANCES.filter((a) => !SCENE_MAIN.includes(a.key)));

  const isTogether = $derived(wled.scope === 'together');
  // Segment ciblé par les contrôles : le segment unique en Ensemble, la ligne
  // sélectionnée (tap sur sa barre) en Par ligne.
  const target = $derived(
    isTogether
      ? (wled.segments[0] ?? null)
      : (wled.segments.find((s) => s.id === selectedId) ?? wled.segments[0] ?? null)
  );

  $effect(() => {
    if (!isTogether && wled.segments.length && !wled.segments.some((s) => s.id === selectedId)) {
      selectedId = wled.segments[0].id;
    }
  });

  // Badge d'état SEULEMENT si anormal — « connecté » est l'état attendu, pas une info.
  const abnormal = $derived(!wled.connected ? 'Hors ligne' : wled.isMock ? 'Démo' : null);

  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  const ctlDisabled = $derived(!wled.on);
  const effLoaded = $derived(wled.effects.length > 0);

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

  // La chip Musique dit « Musique », point — les états (en attente, analyse,
  // pause) vivent dans la LÉGENDE de la barre, seule à avoir la place de les
  // écrire en entier (le libellé dynamique était tronqué à 72 px : du bruit).

  /** Un réglage manuel reprend la main sur le suivi musique. */
  function manual(): void {
    wledMusic.releaseControl();
  }
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- ─── En-tête : titre (+ badge seulement si anormal) + interrupteur ─── -->
  <div class="flex items-center gap-3">
    <span
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {wled.on
        ? 'var(--color-primary)'
        : 'var(--color-consumption-muted)'}; color: {wled.on
        ? 'var(--color-primary-fg)'
        : 'var(--color-consumption)'};"
      aria-hidden="true"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 1 4 12.8c-.6.5-1 1.2-1 2v1H9v-1c0-.8-.4-1.5-1-2A7 7 0 0 1 12 2z" />
      </svg>
    </span>

    <div class="flex min-w-0 flex-1 items-center gap-2">
      <span class="truncate text-[15px] font-semibold" style="color: var(--color-fg);">
        Éclairage terrasse
      </span>
      {#if abnormal}
        <span
          class="badge"
          style="color: {wled.connected ? 'var(--color-mandarine)' : 'var(--color-alert)'};"
        >
          {abnormal}
        </span>
      {/if}
    </div>

    <label class="toggle-pill" aria-label="Allumer / éteindre l'éclairage terrasse">
      <input
        type="checkbox"
        checked={wled.on}
        onchange={(e) => {
          haptic('light');
          // L'interrupteur coupe la LUMIÈRE, pas le mode Musique : le serveur
          // suspend le stream tant que le ruban est éteint et ne rallume jamais
          // de lui-même.
          wled.setOn((e.currentTarget as HTMLInputElement).checked);
        }}
      />
      <span class="toggle-pill-knob"></span>
    </label>
  </div>

  <!-- ─── HÉROS : la lumière elle-même (sélecteur de ligne en mode séparé) ─── -->
  <WledPreview
    animated={preferences.animationsEnabled}
    selectable={!isTogether}
    {selectedId}
    onselect={(id) => {
      haptic('light');
      selectedId = id;
    }}
  />

  {#if wled.segments.length === 0}
    <p class="py-2 text-center text-[13px]" style="color: var(--color-muted-fg);">
      {wled.connected ? 'Aucun segment configuré.' : 'Connexion au module LED…'}
    </p>
  {:else}
    <!-- ─── Luminosité générale — une ligne compacte, un seul % ─── -->
    <div class="bri-line" class:dimmed={ctlDisabled}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-muted-fg)"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2"
        />
      </svg>
      <input
        type="range"
        class="bri-range"
        min="0"
        max="255"
        value={wled.bri}
        disabled={ctlDisabled}
        oninput={(e) => wled.setBri(+(e.currentTarget as HTMLInputElement).value)}
        onchange={() => haptic('light')}
        aria-label="Luminosité générale"
      />
      <span class="bri-pct tabular-nums">{briPct}%</span>
    </div>

    <!-- ─── Scènes : Musique (suit le lecteur) + ambiances ─── -->
    <div class="scene-row" role="group" aria-label="Scènes">
      <button
        type="button"
        class="scene"
        class:scene-active={wledMusic.enabled}
        aria-pressed={wledMusic.enabled}
        onclick={() => {
          haptic('medium');
          wledMusic.setEnabled(!wledMusic.enabled);
        }}
      >
        <span class="scene-dot scene-dot-idle" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
        <span class="scene-label">Musique</span>
      </button>

      {#each scenesMain as a (a.key)}
        {@render sceneChip(a)}
      {/each}

      <!-- « … » déplie les autres scènes SUR PLACE — pas de menu. -->
      {#if moreScenes}
        {#each scenesMore as a (a.key)}
          {@render sceneChip(a)}
        {/each}
      {/if}
      <button
        type="button"
        class="scene"
        aria-label={moreScenes ? 'Moins de scènes' : 'Plus de scènes'}
        aria-expanded={moreScenes}
        onclick={() => {
          haptic('light');
          moreScenes = !moreScenes;
        }}
      >
        <span class="scene-dot scene-dot-idle scene-more" aria-hidden="true">
          {moreScenes ? '−' : '…'}
        </span>
        <span class="scene-label">{moreScenes ? 'Moins' : 'Plus'}</span>
      </button>
    </div>

    <!-- ─── Styles musicaux : 2 groupes titrés (état serveur) ───
         Un effet ♪ ne suit QUE le volume — c'est sa conception WLED : le dire
         évite de chercher des fréquences là où il n'y en aura jamais. -->
    {#if wledMusic.enabled}
      <div role="radiogroup" aria-label="Style musical" class="flex flex-col gap-1.5">
        {#each [{ kind: 'freq', title: 'Réagit aux fréquences' }, { kind: 'vol', title: 'Réagit au volume' }] as grp (grp.kind)}
          <span class="style-group-title">{grp.title}</span>
          <div class="style-grid">
            {#each WLED_MUSIC_STYLES.filter((s) => s.kind === grp.kind || (grp.kind === 'freq' && s.kind === 'ambiance')) as st (st.key)}
              <button
                type="button"
                class="style-chip"
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

    <!-- ─── Réglages : UNE décision à la fois (Couleur | Effet | Lignes) ─── -->
    <button
      type="button"
      class="disclosure"
      aria-expanded={showCustom}
      onclick={() => (showCustom = !showCustom)}
    >
      <span>Réglages{!isTogether && target ? ` — ${target.name}` : ''}</span>
      <span class="chevron" class:open={showCustom} aria-hidden="true">⌄</span>
    </button>
    {#if showCustom && target}
      <div class="mode-tabs" role="tablist" aria-label="Que voulez-vous régler ?">
        <button
          type="button"
          class="mode-tab"
          class:active={customTab === 'couleur'}
          role="tab"
          aria-selected={customTab === 'couleur'}
          onclick={() => (customTab = 'couleur')}
        >
          Couleur
        </button>
        <button
          type="button"
          class="mode-tab"
          class:active={customTab === 'effet'}
          role="tab"
          aria-selected={customTab === 'effet'}
          onclick={() => (customTab = 'effet')}
        >
          Effet
        </button>
        {#if wled.canSplit || !isTogether}
          <button
            type="button"
            class="mode-tab"
            class:active={customTab === 'lignes'}
            role="tab"
            aria-selected={customTab === 'lignes'}
            onclick={() => (customTab = 'lignes')}
          >
            Lignes
          </button>
        {/if}
      </div>

      {#if customTab === 'couleur'}
        {@render colorPanel(target)}
      {:else if customTab === 'effet'}
        {@render effectPanel(target)}
      {:else if customTab === 'lignes'}
        {@render linesPanel()}
      {/if}
    {/if}
  {/if}
</section>

<!-- ─── Chip de scène (façade + panneau Personnaliser) ─── -->
{#snippet sceneChip(a: (typeof WLED_AMBIANCES)[number])}
  <button
    type="button"
    class="scene"
    onclick={() => {
      haptic('medium');
      manual();
      wled.applyAmbiance(a.key);
    }}
  >
    <span
      class="scene-dot"
      class:scene-off={a.off}
      style={a.off ? '' : `background: ${a.swatch};`}
      aria-hidden="true"
    ></span>
    <span class="scene-label">{a.label}</span>
  </button>
{/snippet}

<!-- ─── Panneau « Personnaliser » du segment ciblé ─── -->
{#snippet colorPanel(s: WledSegment)}
  <!-- Vue COULEUR : les pastilles, le blanc — rien d'autre. -->
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
      <div class="bri-line">
        <span class="bri-mini-label">Blanc 4000K</span>
        <input
          type="range"
          class="bri-range white-range"
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
        <span class="bri-pct tabular-nums">{Math.round((s.white / 255) * 100)}%</span>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet effectPanel(s: WledSegment)}
  {@const isSolid = !effLoaded || (wled.effects[s.fx] ?? 'Solid') === 'Solid'}
  <!-- Vue EFFET : des noms simples + UNE vitesse. Le reste est un catalogue
       replié. (Choisir un effet remet ses couleurs par défaut : zéro réglage
       de « palette » à comprendre.) -->
  <div class="flex flex-col gap-3" class:dimmed={ctlDisabled}>
    <div class="fx-curated">
      {#each curatedFx as c (c.idx)}
        <button
          type="button"
          class="fx-chip"
          class:active={s.fx === c.idx}
          aria-pressed={s.fx === c.idx}
          disabled={ctlDisabled}
          onclick={() => {
            manual();
            wled.setSegEffect(s.id, c.idx);
            wled.setSegPalette(s.id, 0); // couleurs par défaut de l'effet
          }}
        >
          {c.label}
        </button>
      {/each}
    </div>

    {#if effLoaded && !isSolid}
      <div class="bri-line">
        <span class="bri-mini-label">Vitesse</span>
        <input
          type="range"
          class="bri-range"
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
        class="fx-search"
        placeholder="Rechercher un effet…"
        bind:value={fxQuery}
        disabled={ctlDisabled}
        aria-label="Rechercher un effet"
      />
      <div class="fx-grid" role="listbox" aria-label="Tous les effets">
        {#each fxFiltered as e (e.i)}
          <button
            type="button"
            class="fx-chip"
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

{#snippet linesPanel()}
  <!-- Vue LIGNES : piloter ensemble ou séparément, et la ligne choisie. -->
  <div class="flex flex-col gap-3">
    <button
      type="button"
      class="split-toggle"
      onclick={() => {
        haptic('light');
        wled.setScope(isTogether ? 'perLine' : 'together');
      }}
    >
      {isTogether ? 'Régler les lignes séparément' : 'Piloter toutes les lignes ensemble'}
    </button>
    {#if !isTogether && target}
      <div class="line-panel" class:dimmed={ctlDisabled}>
        <div class="flex items-center justify-between">
          <span class="text-[13px] font-semibold" style="color: var(--color-fg);">
            {target.name}
          </span>
          <label class="toggle-pill" aria-label="Allumer / éteindre {target.name}">
            <input
              type="checkbox"
              checked={target.on}
              disabled={!wled.on}
              onchange={(e) => {
                haptic('light');
                wled.setSegOn(target.id, (e.currentTarget as HTMLInputElement).checked);
              }}
            />
            <span class="toggle-pill-knob"></span>
          </label>
        </div>
        <div class="bri-line">
          <span class="bri-mini-label">Luminosité</span>
          <input
            type="range"
            class="bri-range"
            min="0"
            max="255"
            value={target.bri}
            disabled={ctlDisabled}
            oninput={(e) => wled.setSegBri(target.id, +(e.currentTarget as HTMLInputElement).value)}
            onchange={() => haptic('light')}
            aria-label="Luminosité {target.name}"
          />
          <span class="bri-pct tabular-nums">{Math.round((target.bri / 255) * 100)}%</span>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .badge {
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  /* ─── Interrupteur (toggle-pill iOS, 44×24) ─── */
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
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 1;
  }
  .toggle-pill input:disabled {
    cursor: not-allowed;
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

  /* ─── Ligne luminosité compacte : [icône/libellé | slider | %] ─── */
  .bri-line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .bri-pct {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-fg);
    min-width: 38px;
    text-align: right;
  }
  .bri-mini-label {
    font-size: 12px;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }

  /* ─── Slider générique ─── */
  .bri-range {
    width: 100%;
    min-width: 0;
    flex: 1;
    height: 6px;
    appearance: none;
    background: var(--color-muted);
    border-radius: 9999px;
    cursor: pointer;
  }
  .bri-range:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .bri-range::-webkit-slider-thumb {
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-primary);
    cursor: pointer;
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  }
  .bri-range::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 50%;
    background: var(--color-primary);
    cursor: pointer;
  }
  .bri-range:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }
  .white-range {
    background: linear-gradient(90deg, var(--color-muted), rgb(255 223 191));
  }

  /* ─── Scènes (pastilles rondes + libellé, défilement horizontal) ─── */
  .scene-row {
    display: flex;
    flex-wrap: wrap; /* dépliée (« … ») → 2ᵉ ligne visible, jamais de scroll caché */
    gap: 4px;
    margin-inline: -4px;
    padding: 4px;
  }
  .scene-row::-webkit-scrollbar {
    display: none;
  }
  .scene {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-width: 64px;
    padding: 6px 4px;
    border: none;
    background: transparent;
    border-radius: var(--radius-lg);
    cursor: pointer;
    scroll-snap-align: start;
    -webkit-tap-highlight-color: transparent;
  }
  .scene:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .scene-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid oklch(1 0 0 / 0.25);
    box-shadow:
      inset 0 1px 2px oklch(1 0 0 / 0.4),
      0 1px 4px oklch(0.1 0.01 286 / 0.2);
    color: var(--color-muted-fg);
    transition: outline-color var(--duration-fast) var(--ease-default);
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
  .scene-active .scene-dot {
    outline-color: var(--color-primary);
  }
  .scene-active .scene-label {
    color: var(--color-primary);
    font-weight: 600;
  }
  .scene-dot-idle {
    background: var(--color-muted);
  }
  .scene-more {
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    color: var(--color-fg);
  }
  .scene-off {
    background:
      linear-gradient(
        45deg,
        transparent 45%,
        var(--color-alert) 45%,
        var(--color-alert) 55%,
        transparent 55%
      ),
      var(--color-muted);
  }
  .scene-label {
    font-size: 11px;
    color: var(--color-muted-fg);
    max-width: 72px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .style-group-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    padding-top: 2px;
  }

  /* ─── Styles musicaux : grille compacte, entière (pas de scroll interne :
     deux zones défilantes empilées coupaient les chips à mi-hauteur) ─── */
  .style-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 6px;
    padding: 2px;
  }
  .style-chip {
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: transparent;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .style-chip:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .style-chip.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary-active);
    font-weight: 600;
  }
  .style-chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ─── Onglets du panneau Réglages : UNE décision à la fois ─── */
  .mode-tabs {
    display: flex;
    gap: 6px;
    padding: 4px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
  }
  .mode-tab {
    flex: 1;
    min-height: 44px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .mode-tab.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .mode-tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ─── Bascule Ensemble ⇄ Par ligne (action rare → discrète) ─── */
  .split-toggle {
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 6px 14px;
    border: none;
    background: transparent;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-primary);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .split-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }

  /* ─── Panneau de la ligne sélectionnée ─── */
  .line-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  /* ─── Effets ─── */
  .fx-curated {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .fx-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 6px;
    max-height: 200px;
    overflow-y: auto;
    padding: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .fx-chip {
    min-height: 40px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: transparent;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .fx-chip:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .fx-chip.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary-active);
  }
  .fx-chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .fx-chip:disabled {
    cursor: not-allowed;
  }

  .fx-search {
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-card-hover);
    color: var(--color-fg);
    font-size: 16px;
  }
  .fx-search:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  /* ─── Bouton dépliant ─── */
  .disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 40px;
    padding: 8px 4px;
    background: transparent;
    border: none;
    border-top: 1px solid var(--color-border);
    color: var(--color-muted-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .disclosure:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .chevron {
    transition: transform var(--duration-normal) var(--ease-default);
  }
  .chevron.open {
    transform: rotate(180deg);
  }

  .dimmed {
    opacity: 0.45;
  }
</style>
