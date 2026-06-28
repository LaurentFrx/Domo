<script lang="ts">
  /**
   * Carte de contrôle de l'éclairage terrasse (WLED — QuinLed Dig-Uno V3).
   *
   * Deux segments = deux lignes LED : « Store » (bras du store banne) et
   * « SàM Été » (véranda). Maître (on/off + luminosité), ambiances rapides,
   * puis contrôles par segment : on/off, luminosité, couleur, effet, palette,
   * vitesse, intensité. Pilotée par le store wled (mock tant que le module
   * n'est pas branché → badge « Démo »).
   */
  import { wled, WLED_AMBIANCES, type RGB } from '$stores/wled.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import { haptic } from '$utils/haptic';

  let selectedId = $state(0);

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
  const isSolid = $derived(seg ? seg.fx === wled.solidFx : true);
  const segCtlDisabled = $derived(!wled.on || !seg);

  function segDotCss(s: { on: boolean; col: RGB }): string {
    return s.on ? `rgb(${s.col[0]} ${s.col[1]} ${s.col[2]})` : 'var(--color-muted)';
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
        ? 'var(--color-solar)'
        : 'var(--color-consumption-muted)'}; color: {wled.on
        ? 'white'
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

  <!-- ─── Luminosité maître ─── -->
  {#if wled.on}
    <div class="flex flex-col gap-1.5">
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
        oninput={(e) => wled.setBri(+(e.currentTarget as HTMLInputElement).value)}
        aria-label="Luminosité générale"
      />
    </div>
  {/if}

  <!-- ─── Ambiances rapides (appliquées aux deux lignes) ─── -->
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
    <div class="seg-tabs">
      {#each wled.segments as s (s.id)}
        <button
          type="button"
          class="seg-tab"
          class:active={s.id === selectedId}
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
      <div class="grid gap-4 lg:grid-cols-2" class:dimmed={segCtlDisabled}>
        <!-- Colonne 1 : on/off + luminosité + couleur -->
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
              <span class="font-semibold tabular-nums" style="color: var(--color-fg);"
                >{segBriPct}%</span
              >
            </div>
            <input
              type="range"
              class="bri-range"
              min="0"
              max="255"
              value={s.bri}
              disabled={segCtlDisabled}
              oninput={(e) => wled.setSegBri(s.id, +(e.currentTarget as HTMLInputElement).value)}
              aria-label="Luminosité {s.name}"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px]" style="color: var(--color-muted-fg);">Couleur</span>
            <WledColorPicker
              color={s.col}
              disabled={segCtlDisabled}
              onpick={(rgb) => wled.setSegColor(s.id, rgb)}
            />
          </div>
        </div>

        <!-- Colonne 2 : effet + palette + vitesse/intensité -->
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px]" style="color: var(--color-muted-fg);">Effet</span>
            <div class="fx-grid">
              {#each wled.effects as name, i (name)}
                <button
                  type="button"
                  class="fx-chip"
                  class:active={s.fx === i}
                  disabled={segCtlDisabled}
                  onclick={() => wled.setSegEffect(s.id, i)}
                >
                  {name}
                </button>
              {/each}
            </div>
          </div>

          {#if wled.palettes.length}
            <label class="flex flex-col gap-1.5">
              <span class="text-[12px]" style="color: var(--color-muted-fg);">Palette</span>
              <select
                class="pal-select"
                disabled={segCtlDisabled}
                onchange={(e) =>
                  wled.setSegPalette(s.id, +(e.currentTarget as HTMLSelectElement).value)}
              >
                {#each wled.palettes as name, i (name)}
                  <option value={i} selected={s.pal === i}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}

          {#if !isSolid}
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
                  aria-label="Intensité de l'effet"
                />
              </div>
            </div>
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

  /* ─── Slider générique (luminosité / vitesse / intensité) ─── */
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
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--color-primary);
    cursor: pointer;
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  }
  .bri-range::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: var(--color-primary);
    cursor: pointer;
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
    padding: 5px 11px 5px 7px;
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
    background: var(--color-card);
    border-color: var(--color-border);
    color: var(--color-fg);
    box-shadow: 0 1px 3px oklch(0.1 0.01 286 / 0.12);
  }
  .seg-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid oklch(1 0 0 / 0.25);
  }

  /* ─── Grille d'effets (défilable) ─── */
  .fx-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 6px;
    max-height: 168px;
    overflow-y: auto;
    padding: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .fx-chip {
    padding: 6px 8px;
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
    color: var(--color-primary);
  }
  .fx-chip:disabled {
    cursor: not-allowed;
  }

  /* ─── Sélecteur de palette (natif, font 16px = pas de zoom iOS) ─── */
  .pal-select {
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-card);
    color: var(--color-fg);
    font-size: 16px;
    cursor: pointer;
  }
  .pal-select:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  /* Zone de contrôle grisée quand l'éclairage est éteint. */
  .dimmed {
    opacity: 0.45;
  }
</style>
