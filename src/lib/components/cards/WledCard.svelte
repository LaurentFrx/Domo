<script lang="ts">
  /**
   * Carte de l'éclairage terrasse (WLED — QuinLed Dig-Uno V3).
   *
   * REFONTE 03/08/2026 — la carte ne montre plus que ce qu'on touche en passant :
   *   1. en-tête : titre, ÉTAT EN UNE LIGNE (« Musique · Spectre », « 62 % ·
   *      Bougie », « Éteint »), interrupteur ;
   *   2. la barre de lumière (WledPreview), animée par le niveau sonore serveur
   *      quand la musique joue — même donnée que le ruban ;
   *   3. luminosité, une ligne ;
   *   4. scènes rapides : Musique + 3 ambiances + « Plus ».
   *
   * Tout le reste — 8 ambiances, 24 styles musicaux, sélecteur de couleur, 100+
   * effets, pilotage ligne par ligne — vit dans une FEUILLE à sous-vues
   * (`WledSheet.svelte`). Avant, tout cela se dépliait DANS la carte, qui
   * dépassait alors plusieurs écrans de haut sur iPhone : on scrollait pour
   * régler, et la page /pieces devenait illisible.
   *
   * Le mode Musique est un état SERVEUR partagé (SSE /api/wled/music/live) : la
   * chip et la légende reflètent le ruban réel, jamais un flag local.
   */
  import { wled, WLED_AMBIANCES } from '$stores/wled.svelte';
  import { wledMusic, WLED_MUSIC_STYLES } from '$stores/wledMusic.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import WledPreview from './WledPreview.svelte';
  import WledSheet, { type WledTab } from './WledSheet.svelte';
  import { haptic } from '$utils/haptic';

  let selectedId = $state(0);
  /** Feuille de réglage : fermée par défaut, ouverte sur la vue demandée. */
  let sheetOpen = $state(false);
  let sheetTab = $state<WledTab>('scenes');

  function openSheet(tab: WledTab): void {
    haptic('light');
    sheetTab = tab;
    sheetOpen = true;
  }

  // Flux temps réel du mode Musique (état + niveau sonore) tant que la carte
  // est à l'écran — refcounté et suspendu en arrière-plan dans le store.
  $effect(() => {
    wledMusic.openLive();
    return () => wledMusic.closeLive();
  });

  // Scènes rapides : les 3 gestes du quotidien. Le reste est dans la feuille.
  const SCENE_MAIN = ['blanc', 'warm', 'soiree'];
  const scenesMain = $derived(WLED_AMBIANCES.filter((a) => SCENE_MAIN.includes(a.key)));

  const isTogether = $derived(wled.scope === 'together');
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

  // ─── Sous-titre : l'état en UNE ligne ──────────────────────────────────
  // Ce que la carte ne montre plus en détail, elle doit au moins le RÉSUMER :
  // sans ça, replier les réglages reviendrait à cacher ce que fait le ruban.
  const FX_FR: Record<string, string> = {
    Solid: 'Couleur fixe',
    Breathe: 'Respiration',
    Candle: 'Bougie',
    'Candle Multi': 'Bougie',
    'Fire 2012': 'Feu',
    'Fire Flicker': 'Feu',
    Twinklefox: 'Scintillement',
    Twinkle: 'Scintillement',
    Rainbow: 'Arc-en-ciel',
    Colorwaves: 'Vagues',
    Colorloop: 'Vagues',
    Running: 'Poursuite',
    Chase: 'Poursuite',
    Scanner: 'Balayage',
    Scan: 'Balayage',
    'Multi Comet': 'Comète',
    Meteor: 'Comète',
    Aurora: 'Aurore',
    Pacifica: 'Océan',
    Lake: 'Océan'
  };
  const musicStyleLabel = $derived(
    WLED_MUSIC_STYLES.find((s) => s.key === wledMusic.style)?.label ?? null
  );
  const subtitle = $derived.by(() => {
    if (!wled.connected) return null; // le badge « Hors ligne » le dit déjà
    if (!wled.on) return 'Éteint';
    if (wledMusic.enabled) return musicStyleLabel ? `Musique · ${musicStyleLabel}` : 'Musique';
    const fxName = target ? (wled.effects[target.fx] ?? '') : '';
    const fxLabel = FX_FR[fxName] ?? (fxName ? fxName : null);
    return fxLabel ? `${briPct} % · ${fxLabel}` : `${briPct} %`;
  });

  /** Un réglage manuel reprend la main sur le suivi musique. */
  function manual(): void {
    wledMusic.releaseControl();
  }
</script>

<section
  class="flex flex-col gap-3.5 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- ─── En-tête : titre + état résumé + interrupteur ─── -->
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
      <div class="flex min-w-0 items-center gap-2">
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
      {#if subtitle}
        <span class="truncate text-[11.5px]" style="color: var(--color-muted-fg);">{subtitle}</span>
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

  <!-- ─── La lumière elle-même (sélecteur de ligne en mode séparé) ─── -->
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
    <!-- ─── Luminosité — une ligne, un seul % ─── -->
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

    <!-- ─── Scènes rapides + accès aux sous-vues ─── -->
    <!-- Les 3 ambiances du quotidien restent à portée de pouce ; « Plus » ouvre
         la feuille, où vivent les 8 ambiances, la musique et ses 24 styles. -->
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
        <button
          type="button"
          class="scene"
          onclick={() => {
            haptic('medium');
            manual();
            wled.applyAmbiance(a.key);
          }}
        >
          <span class="scene-dot" style="background: {a.swatch};" aria-hidden="true"></span>
          <span class="scene-label">{a.label}</span>
        </button>
      {/each}

      <button
        type="button"
        class="scene"
        aria-haspopup="dialog"
        onclick={() => openSheet('scenes')}
      >
        <span class="scene-dot scene-dot-idle scene-more" aria-hidden="true">…</span>
        <span class="scene-label">Plus</span>
      </button>
    </div>

    <!-- ─── Accès aux sous-vues : 3 destinations, pas 3 panneaux dépliés ─── -->
    <div class="jump-row">
      <button
        type="button"
        class="jump"
        aria-haspopup="dialog"
        onclick={() => openSheet('couleur')}
      >
        Couleur
      </button>
      <button type="button" class="jump" aria-haspopup="dialog" onclick={() => openSheet('effet')}>
        Effet
      </button>
      <button type="button" class="jump" aria-haspopup="dialog" onclick={() => openSheet('lignes')}>
        {isTogether ? 'Lignes' : (target?.name ?? 'Lignes')}
      </button>
    </div>
  {/if}
</section>

<WledSheet open={sheetOpen} bind:tab={sheetTab} {selectedId} onClose={() => (sheetOpen = false)} />

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

  /* ─── Ligne luminosité : [icône | slider | %] ─── */
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
  .dimmed {
    opacity: 0.45;
    pointer-events: none;
  }

  /* ─── Scènes rapides (pastille ronde + libellé) ─── */
  .scene-row {
    display: flex;
    gap: 4px;
    margin-inline: -4px;
    padding: 2px 4px;
  }
  .scene {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    border: none;
    background: transparent;
    border-radius: var(--radius-lg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .scene:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .scene-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
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
  .scene-label {
    font-size: 11px;
    color: var(--color-muted-fg);
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Raccourcis vers les sous-vues ─── */
  .jump-row {
    display: flex;
    gap: 6px;
  }
  .jump {
    flex: 1 1 0;
    min-width: 0;
    padding: 9px 6px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .jump:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-pill-knob,
    .toggle-pill-knob::after,
    .scene-dot {
      transition: none;
    }
  }
</style>
