<script lang="ts">
  /**
   * Feuille de réglages de l'éclairage terrasse (ouverte depuis WledTile).
   *
   * La tuile porte l'essentiel au quotidien (allumé/éteint + luminosité) ; TOUT
   * le reste vit ici, avec la place de respirer. Structure : ce qui est vrai en
   * permanence en haut (la barre de lumière + luminosité + interrupteur), puis
   * UNE décision à la fois via un seul niveau d'onglets — l'ancien empilement
   * scènes / styles / accordéon / sous-onglets faisait deux niveaux imbriqués.
   *
   * Le mode Musique est un état SERVEUR partagé (SSE /api/wled/music/live) : la
   * bascule, les styles et la légende reflètent le ruban réel, jamais un flag
   * local à l'appareil.
   *
   * BottomSheet ne rend ses enfants que lorsqu'elle est ouverte : l'aperçu
   * animé (et sa boucle rAF) ne vit donc que le temps de la feuille.
   */
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import WledPreview from './WledPreview.svelte';
  import { wled, WLED_AMBIANCES, type WledSegment } from '$stores/wled.svelte';
  import { wledMusic, WLED_MUSIC_STYLES } from '$stores/wledMusic.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { acquire } from '$stores/refcount';
  import { haptic } from '$utils/haptic';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  // La feuille vit au LAYOUT (elle échappe au rail du Pager — cf.
  // wled-sheet-state) : elle ne peut plus compter sur /pieces pour le polling
  // wled ni sur WledCard pour le SSE musique — tous deux meurent si /pieces
  // sort de la fenêtre du Pager (retour arrière sous la modale) alors que la
  // feuille, globale, reste ouverte sur un état figé sans le savoir. Tant
  // qu'elle est ouverte, elle tient donc ses PROPRES références ; le refcount
  // fait qu'aucun doublon n'existe quand /pieces est montée en même temps.
  $effect(() => {
    if (!open) return;
    const release = acquire(wled);
    wledMusic.openLive();
    return () => {
      release();
      wledMusic.closeLive();
    };
  });

  type Tab = 'ambiances' | 'musique' | 'couleur' | 'effet' | 'lignes';
  let tab = $state<Tab>('ambiances');
  let selectedId = $state(0);
  let showAllFx = $state(false);
  let fxQuery = $state('');

  const isTogether = $derived(wled.scope === 'together');
  /** Segment ciblé par Couleur / Effet : l'unique en Ensemble, la ligne
   *  sélectionnée (tap sur sa barre dans l'aperçu) en Par ligne. */
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

  // L'onglet Lignes n'existe que si le découpage a un sens sur ce module.
  const tabs = $derived<{ key: Tab; label: string }[]>([
    { key: 'ambiances', label: 'Ambiances' },
    { key: 'musique', label: 'Musique' },
    { key: 'couleur', label: 'Couleur' },
    { key: 'effet', label: 'Effet' },
    ...(wled.canSplit || !isTogether ? [{ key: 'lignes' as Tab, label: 'Lignes' }] : [])
  ]);
  // Le module peut perdre sa 2ᵉ ligne pendant que la feuille est ouverte :
  // l'onglet disparaîtrait en laissant un panneau vide.
  $effect(() => {
    if (!tabs.some((t) => t.key === tab)) tab = 'ambiances';
  });

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

  /** Un réglage manuel reprend la main sur le suivi musique. */
  function manual(): void {
    wledMusic.releaseControl();
  }
</script>

<BottomSheet {open} title="Terrasse" {onClose}>
  {#if wled.segments.length === 0}
    <p class="py-4 text-center text-[13px]" style="color: var(--color-muted-fg);">
      {wled.connected ? 'Aucun segment configuré.' : 'Connexion au module LED…'}
    </p>
  {:else}
    <!-- ─── Toujours vrai : la lumière, sa luminosité, son interrupteur ─── -->
    <WledPreview
      animated={preferences.animationsEnabled}
      selectable={!isTogether}
      {selectedId}
      onselect={(id) => {
        haptic('light');
        selectedId = id;
      }}
    />

    <div class="master-row">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-muted-fg)"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
        class="shrink-0"
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
      <label class="toggle-pill" aria-label="Allumer / éteindre l'éclairage terrasse">
        <input
          type="checkbox"
          checked={wled.on}
          onchange={(e) => {
            haptic('light');
            wled.setOn((e.currentTarget as HTMLInputElement).checked);
          }}
        />
        <span class="toggle-pill-knob"></span>
      </label>
    </div>

    <!-- ─── UNE décision à la fois — un SEUL niveau d'onglets ─── -->
    <div class="tabs" role="tablist" aria-label="Que voulez-vous régler ?">
      {#each tabs as t (t.key)}
        <button
          type="button"
          class="tab"
          class:active={tab === t.key}
          role="tab"
          aria-selected={tab === t.key}
          onclick={() => (tab = t.key)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === 'ambiances'}
      <!-- Toutes les ambiances, d'un coup : la feuille a la place que la carte
           n'avait pas (fini le « … » qui dépliait une 2ᵉ rangée). -->
      <div class="scene-grid" role="group" aria-label="Ambiances">
        {#each WLED_AMBIANCES as a (a.key)}
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
        {/each}
      </div>
    {:else if tab === 'musique'}
      <div class="flex flex-col gap-3">
        <div class="master-row">
          <span class="flex-1 text-[13px] font-semibold" style="color: var(--color-fg);">
            Suivre la musique
          </span>
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
          <!-- Un effet ♪ ne suit QUE le volume — c'est sa conception WLED : le
               dire évite de chercher des fréquences là où il n'y en aura jamais. -->
          <div role="radiogroup" aria-label="Style musical" class="flex flex-col gap-1.5">
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
        {:else}
          <p class="text-[12.5px]" style="color: var(--color-muted-fg);">
            Le ruban suivra le morceau en cours de lecture, pour tous les appareils.
          </p>
        {/if}
      </div>
    {:else if target}
      {#if !isTogether}
        <span class="applies-to">
          S'applique à <strong>{target.name}</strong> — touchez une barre ci-dessus pour changer de ligne.
        </span>
      {/if}
      {#if tab === 'couleur'}
        {@render colorPanel(target)}
      {:else if tab === 'effet'}
        {@render effectPanel(target)}
      {:else if tab === 'lignes'}
        {@render linesPanel()}
      {/if}
    {/if}
  {/if}
</BottomSheet>

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
      <div class="master-row">
        <span class="mini-label">Blanc 4000K</span>
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
    <div class="chip-wrap">
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
            wled.setSegPalette(s.id, 0); // couleurs par défaut de l'effet
          }}
        >
          {c.label}
        </button>
      {/each}
    </div>

    {#if effLoaded && !isSolid}
      <div class="master-row">
        <span class="mini-label">Vitesse</span>
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
            {e.name}{#if wled.audioFx.has(e.i)}<span class="fx-audio" aria-label="suit la musique"
                >&nbsp;♫</span
              >{/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- 37 des 220 effets du firmware NE VIVENT QUE du flux musique : posés
         sans lecture en cours, ils rendent un ruban noir ou figé qu'on prend
         pour une panne. Le dire au moment où ça arrive, en mots simples. -->
    {#if effLoaded && wled.audioFx.has(s.fx) && !wledMusic.playing}
      <p class="fx-audio-note">
        ♫ Cet effet suit la musique — lancez une lecture (ou choisissez le mode Musique de l'onglet
        dédié) pour le voir vivre. Sans musique, le ruban reste sombre.
      </p>
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
        <div class="master-row">
          <span class="mini-label">Luminosité</span>
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
  /* ─── Rangée générique [libellé/icône | slider | valeur | interrupteur] ─── */
  .master-row {
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
  .mini-label {
    font-size: 12px;
    color: var(--color-muted-fg);
    white-space: nowrap;
  }

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

  /* ─── Onglets : un seul niveau, défilables si l'écran est étroit ─── */
  .tabs {
    display: flex;
    gap: 3px;
    padding: 4px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    /* Serré pour que les 5 onglets tiennent d'un bloc sur iPhone (le
       défilement horizontal reste le filet de sécurité, pas la norme). */
    flex: 1 0 auto;
    min-height: 44px;
    padding: 8px 9px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .tab.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .applies-to {
    font-size: 12px;
    color: var(--color-muted-fg);
  }
  .applies-to strong {
    color: var(--color-fg);
  }

  /* ─── Ambiances : grille de pastilles (toutes visibles) ─── */
  .scene-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
    gap: 6px;
    padding: 2px;
  }
  .scene {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px 4px;
    border: none;
    background: transparent;
    border-radius: var(--radius-lg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .scene:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .scene-dot {
    display: inline-flex;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid oklch(1 0 0 / 0.25);
    box-shadow:
      inset 0 1px 2px oklch(1 0 0 / 0.4),
      0 1px 4px oklch(0.1 0.01 286 / 0.2);
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
    max-width: 84px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Chips (styles musicaux, effets) ─── */
  .group-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    padding-top: 2px;
  }
  .chip-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 6px;
    padding: 2px;
  }
  .chip-wrap {
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
  .chip {
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 9999px;
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
  .chip:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .chip.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary-active);
    font-weight: 600;
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .chip:disabled {
    cursor: not-allowed;
  }

  /* Marqueur des effets audio-réactifs : discret dans la grille, la note
     au-dessous porte l'explication quand on en pose un sans musique. */
  .fx-audio {
    color: var(--color-primary);
    font-size: 11px;
  }
  .chip.active .fx-audio {
    color: inherit;
  }
  .fx-audio-note {
    padding: 8px 10px;
    border-radius: var(--radius-md);
    background: var(--color-card-hover);
    border: 1px solid var(--color-border);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--color-muted-fg);
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

  .line-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  /* ─── Bouton dépliant (catalogue d'effets) ─── */
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
    z-index: 1;
    margin: 0;
    cursor: pointer;
    opacity: 0;
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

  .dimmed {
    opacity: 0.45;
  }
</style>
