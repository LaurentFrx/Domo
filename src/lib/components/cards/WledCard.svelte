<script lang="ts">
  /**
   * Carte de contrôle de l'éclairage terrasse (WLED — QuinLed Dig-Uno V3).
   *
   * Ruban COB RGBW 4000K : canal blanc dédié (slider « Blanc 4000K ») + teinte
   * RGB (picker avec saturation). Aperçu visuel live en tête (WledPreview).
   *
   * Deux segments = deux lignes LED : « Store » (bras du store banne) et
   * « SàM Été » (véranda). Maître (on/off + luminosité), ambiances rapides, puis
   * par segment : on/off, luminosité, blanc, couleur, effet (liste curée FR +
   * tous repliable), et réglages avancés (palette, vitesse, intensité).
   */
  import { wled, WLED_AMBIANCES, previewColor, type RGB } from '$stores/wled.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import WledPreview from './WledPreview.svelte';
  import { haptic } from '$utils/haptic';

  let selectedId = $state(0);
  let showAllFx = $state(false);
  let showAdvanced = $state(false);
  let fxQuery = $state('');

  const seg = $derived(wled.segments.find((s) => s.id === selectedId) ?? wled.segments[0] ?? null);

  // Garde l'onglet de segment valide quand la liste arrive/évolue.
  $effect(() => {
    if (wled.segments.length && !wled.segments.some((s) => s.id === selectedId)) {
      selectedId = wled.segments[0].id;
    }
  });

  const statusLabel = $derived(!wled.connected ? 'Hors ligne' : wled.isMock ? 'Démo' : 'Connecté');
  const statusColor = $derived(
    !wled.connected
      ? 'var(--color-alert)'
      : wled.isMock
        ? 'var(--color-mandarine)'
        : 'var(--color-battery)'
  );

  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  const segBriPct = $derived(seg ? Math.round((seg.bri / 255) * 100) : 0);
  const segWhitePct = $derived(seg ? Math.round((seg.white / 255) * 100) : 0);
  const effLoaded = $derived(wled.effects.length > 0);
  const segFxName = $derived(seg ? (wled.effects[seg.fx] ?? '') : '');
  const isSolid = $derived(!effLoaded || segFxName === 'Solid');
  const segCtlDisabled = $derived(!wled.on || !seg);

  // ─── Effets curés (terrasse) : libellés FR → premier nom WLED présent ───
  const CURATED_FX: { label: string; names: string[] }[] = [
    { label: 'Fixe', names: ['Solid'] },
    { label: 'Respiration', names: ['Breathe'] },
    { label: 'Bougie', names: ['Candle', 'Candle Multi'] },
    { label: 'Feu', names: ['Fire 2012', 'Fire Flicker'] },
    { label: 'Scintillement', names: ['Twinklefox', 'Twinkle'] },
    { label: 'Vagues', names: ['Colorwaves', 'Colorloop'] },
    { label: 'Arc-en-ciel', names: ['Rainbow'] },
    { label: 'Aurore', names: ['Aurora'] },
    { label: 'Océan', names: ['Pacifica', 'Lake'] },
    { label: 'Balayage', names: ['Scanner', 'Scan'] },
    { label: 'Comète', names: ['Multi Comet', 'Meteor'] }
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

  function segDotCss(s: { on: boolean; col: RGB; white: number }): string {
    if (!wled.on || !s.on) return 'var(--color-muted)';
    const e = previewColor(s.col, s.white);
    return `rgb(${e[0]} ${e[1]} ${e[2]})`;
  }
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- ─── En-tête : titre + badge source + interrupteur maître ─── -->
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

    <div class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-[15px] font-semibold" style="color: var(--color-fg);">
        Éclairage terrasse
      </span>
      <span class="flex items-center gap-1.5 text-[11px]" style="color: var(--color-muted-fg);">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full"
          style="background: {statusColor};"
          aria-hidden="true"
        ></span>
        {statusLabel}
      </span>
    </div>

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

  <!-- ─── Aperçu visuel live (rendu COB RGBW « tel que réglé ») ─── -->
  <WledPreview animated={preferences.animationsEnabled} />

  <!-- ─── Luminosité maître (toujours visible, grisée si éteint) ─── -->
  <div class="flex flex-col gap-1.5" class:dimmed={!wled.on}>
    <div class="flex items-center justify-between text-[12px]">
      <span style="color: var(--color-muted-fg);">Luminosité générale</span>
      <span class="font-semibold tabular-nums" style="color: var(--color-fg);">{briPct}%</span>
    </div>
    <input
      type="range"
      class="bri-range"
      min="0"
      max="255"
      value={wled.bri}
      disabled={!wled.on}
      oninput={(e) => wled.setBri(+(e.currentTarget as HTMLInputElement).value)}
      onchange={() => haptic('light')}
      aria-label="Luminosité générale"
    />
  </div>

  <!-- ─── Ambiances rapides (actions, appliquées aux deux lignes) ─── -->
  <div class="flex flex-col gap-1.5">
    <span
      class="text-[11px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Ambiances
    </span>
    <div class="amb-row">
      {#each WLED_AMBIANCES as a (a.key)}
        <button
          type="button"
          class="amb-chip"
          onclick={() => {
            haptic('medium');
            wled.applyAmbiance(a.key);
          }}
        >
          <span
            class="amb-dot"
            class:amb-off={a.off}
            style={a.off ? '' : `background: ${a.swatch};`}
            aria-hidden="true"
          ></span>
          <span class="amb-label">{a.label}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if wled.segments.length === 0}
    <p class="py-2 text-center text-[13px]" style="color: var(--color-muted-fg);">
      {wled.connected ? 'Aucun segment configuré.' : 'Connexion au module LED…'}
    </p>
  {:else}
    <!-- ─── Sélecteur de ligne LED (segment) ─── -->
    <div class="seg-tabs" role="tablist" aria-label="Ligne LED">
      {#each wled.segments as s (s.id)}
        <button
          type="button"
          class="seg-tab"
          class:active={s.id === selectedId}
          role="tab"
          aria-selected={s.id === selectedId}
          onclick={() => (selectedId = s.id)}
        >
          <span class="seg-dot" style="background: {segDotCss(s)};" aria-hidden="true"></span>
          <span class="truncate">{s.name}</span>
        </button>
      {/each}
    </div>

    <!-- ─── Contrôles du segment sélectionné ─── -->
    {#if seg}
      {@const s = seg}
      <div
        class="grid gap-4 lg:grid-cols-2"
        class:dimmed={segCtlDisabled}
        role="tabpanel"
        aria-label={s.name}
      >
        <!-- Colonne 1 : on/off + luminosité + blanc + couleur -->
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="text-[13px] font-semibold" style="color: var(--color-fg);">{s.name}</span>
            <label class="toggle-pill" aria-label="Allumer / éteindre {s.name}">
              <input
                type="checkbox"
                checked={s.on}
                disabled={!wled.on}
                onchange={(e) => {
                  haptic('light');
                  wled.setSegOn(s.id, (e.currentTarget as HTMLInputElement).checked);
                }}
              />
              <span class="toggle-pill-knob"></span>
            </label>
          </div>

          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between text-[12px]">
              <span style="color: var(--color-muted-fg);">Luminosité</span>
              <span class="font-semibold tabular-nums" style="color: var(--color-fg);">
                {segBriPct}%
              </span>
            </div>
            <input
              type="range"
              class="bri-range"
              min="0"
              max="255"
              value={s.bri}
              disabled={segCtlDisabled}
              oninput={(e) => wled.setSegBri(s.id, +(e.currentTarget as HTMLInputElement).value)}
              onchange={() => haptic('light')}
              aria-label="Luminosité {s.name}"
            />
          </div>

          {#if wled.rgbw}
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-[12px]">
                <span style="color: var(--color-muted-fg);">Blanc 4000K</span>
                <span class="font-semibold tabular-nums" style="color: var(--color-fg);">
                  {segWhitePct}%
                </span>
              </div>
              <input
                type="range"
                class="bri-range white-range"
                min="0"
                max="255"
                value={s.white}
                disabled={segCtlDisabled}
                oninput={(e) =>
                  wled.setSegWhite(s.id, +(e.currentTarget as HTMLInputElement).value)}
                onchange={() => haptic('light')}
                aria-label="Canal blanc 4000K {s.name}"
              />
            </div>
          {/if}

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px]" style="color: var(--color-muted-fg);">Couleur (teinte)</span>
            <WledColorPicker
              color={s.col}
              disabled={segCtlDisabled}
              onpick={(rgb) => wled.setSegColor(s.id, rgb)}
            />
          </div>
        </div>

        <!-- Colonne 2 : effet (curé + tous) + avancé (palette, vitesse, intensité) -->
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[12px]" style="color: var(--color-muted-fg);">Effet</span>
              {#if segFxName}
                <span class="truncate text-[11px]" style="color: var(--color-muted-fg);">
                  {segFxName}
                </span>
              {/if}
            </div>
            <div class="fx-curated">
              {#each curatedFx as c (c.idx)}
                <button
                  type="button"
                  class="fx-chip"
                  class:active={s.fx === c.idx}
                  aria-pressed={s.fx === c.idx}
                  disabled={segCtlDisabled}
                  onclick={() => wled.setSegEffect(s.id, c.idx)}
                >
                  {c.label}
                </button>
              {/each}
            </div>

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
                disabled={segCtlDisabled}
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
                    disabled={segCtlDisabled}
                    onclick={() => wled.setSegEffect(s.id, e.i)}
                  >
                    {e.name}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Réglages avancés (repliés par défaut) -->
          <button
            type="button"
            class="disclosure"
            aria-expanded={showAdvanced}
            onclick={() => (showAdvanced = !showAdvanced)}
          >
            <span>Réglages avancés</span>
            <span class="chevron" class:open={showAdvanced} aria-hidden="true">⌄</span>
          </button>

          {#if showAdvanced}
            {#if wled.palettes.length}
              <label class="flex flex-col gap-1.5">
                <span class="text-[12px]" style="color: var(--color-muted-fg);">Palette</span>
                <select
                  class="pal-select"
                  value={s.pal}
                  disabled={segCtlDisabled}
                  onchange={(e) =>
                    wled.setSegPalette(s.id, +(e.currentTarget as HTMLSelectElement).value)}
                >
                  {#each wled.palettes as name, i (name)}
                    <option value={i}>{name}</option>
                  {/each}
                </select>
              </label>
            {/if}

            {#if effLoaded && !isSolid}
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px]" style="color: var(--color-muted-fg);">Vitesse</span>
                  <input
                    type="range"
                    class="bri-range"
                    min="0"
                    max="255"
                    value={s.sx}
                    disabled={segCtlDisabled}
                    oninput={(e) =>
                      wled.setSegSpeed(s.id, +(e.currentTarget as HTMLInputElement).value)}
                    onchange={() => haptic('light')}
                    aria-label="Vitesse de l'effet"
                  />
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px]" style="color: var(--color-muted-fg);">Intensité</span>
                  <input
                    type="range"
                    class="bri-range"
                    min="0"
                    max="255"
                    value={s.ix}
                    disabled={segCtlDisabled}
                    oninput={(e) =>
                      wled.setSegIntensity(s.id, +(e.currentTarget as HTMLInputElement).value)}
                    onchange={() => haptic('light')}
                    aria-label="Intensité de l'effet"
                  />
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
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

  /* ─── Slider générique (luminosité / blanc / vitesse / intensité) ─── */
  .bri-range {
    width: 100%;
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
  /* Canal blanc 4000K : rail teinté blanc chaud pour le distinguer. */
  .white-range {
    background: linear-gradient(90deg, var(--color-muted), rgb(255 223 191));
  }

  /* ─── Ambiances ─── */
  .amb-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .amb-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 6px 12px 6px 8px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: border-color var(--duration-fast) var(--ease-default);
  }
  .amb-chip:hover {
    border-color: var(--color-border-strong);
  }
  .amb-chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .amb-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-fg);
  }
  .amb-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid oklch(1 0 0 / 0.25);
    box-shadow: inset 0 1px 1px oklch(1 0 0 / 0.4);
  }
  .amb-dot.amb-off {
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

  /* ─── Onglets de segment ─── */
  .seg-tabs {
    display: flex;
    gap: 6px;
    padding: 4px;
    border-radius: var(--radius-lg);
    background: var(--color-muted);
  }
  .seg-tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-width: 0;
    min-height: 40px;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: all var(--duration-fast) var(--ease-default);
  }
  .seg-tab.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .seg-tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .seg-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid oklch(1 0 0 / 0.25);
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

  /* ─── Bouton dépliant (effets/avancé) ─── */
  .disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 36px;
    padding: 6px 4px;
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

  /* ─── Sélecteur de palette (natif, font 16px = pas de zoom iOS) ─── */
  .pal-select {
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-card-hover);
    color: var(--color-fg);
    font-size: 16px;
    cursor: pointer;
  }
  .pal-select:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .pal-select:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  /* Zone de contrôle grisée quand l'éclairage / le segment est indisponible. */
  .dimmed {
    opacity: 0.45;
  }
</style>
