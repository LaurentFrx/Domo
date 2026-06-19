<script lang="ts">
  import { onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Switch } from '$stores/matter.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    sw: Switch;
  }

  let { sw }: Props = $props();

  let optimisticOn = $state<boolean | null>(null);
  let optimisticTimer: ReturnType<typeof setTimeout> | null = null;
  let lastServerOn: boolean | null = null;

  const displayedOn = $derived(optimisticOn !== null ? optimisticOn : sw.isOn);

  $effect(() => {
    const cur = sw.isOn;
    if (lastServerOn === null) {
      lastServerOn = cur;
      return;
    }
    if (cur === lastServerOn) return;
    lastServerOn = cur;
    if (optimisticTimer) {
      clearTimeout(optimisticTimer);
      optimisticTimer = null;
    }
    optimisticOn = null;
  });

  function onToggle() {
    if (!sw.available) return;
    const next = !displayedOn;
    optimisticOn = next;
    haptic('light');
    if (optimisticTimer) clearTimeout(optimisticTimer);
    optimisticTimer = setTimeout(() => {
      optimisticOn = null;
      optimisticTimer = null;
    }, 5000);
    matter.toggleSwitch(sw.nodeId);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onToggle();
    }
  }

  onDestroy(() => {
    if (optimisticTimer) clearTimeout(optimisticTimer);
  });

  // ─── Icône + couleur selon le nom du device ───────────────────────────
  // glow* = halos box-shadow pré-calculés (tokens app.css) — jamais de
  // color-mix() dans une box-shadow via var() (piège Chrome).
  type Glyph = 'ev-charger' | 'monitor' | 'towel-heater' | 'plug';
  type TileStyle = {
    glyph: Glyph;
    color: string;
    muted: string;
    glow: string;
    mid: string;
    soft: string;
    // Couleur de l'icône à l'état ÉTEINT (défaut = accent ; forcée en bleu
    // pour certaines tuiles via le 3ᵉ argument de palette()).
    offColor: string;
    offMuted: string;
  };

  // offBase = couleur de l'icône ÉTEINTE (par défaut identique à l'état allumé).
  function palette(base: string, glyph: Glyph, offBase: string = base): TileStyle {
    return {
      glyph,
      color: `var(--color-${base})`,
      muted: `var(--color-${base}-muted)`,
      glow: `var(--color-${base}-glow)`,
      mid: `var(--color-${base}-glow-mid)`,
      soft: `var(--color-${base}-glow-soft)`,
      offColor: `var(--color-${offBase})`,
      offMuted: `var(--color-${offBase}-muted)`
    };
  }

  const style = $derived.by<TileStyle>(() => {
    const n = sw.name.toLowerCase();
    if (n.includes('chargeur') || n.includes('charger') || n.includes('ev')) {
      // Éteint : logo bleu (charte) ; allumé : ambre « solaire » conservé.
      return palette('solar', 'ev-charger', 'consumption');
    }
    if (
      n.includes('multim') ||
      n.includes('bureau') ||
      n.includes('media') ||
      n.includes('écran') ||
      n.includes('ecran')
    ) {
      return palette('consumption', 'monitor');
    }
    if (
      n.includes('serviette') ||
      n.includes('sèche') ||
      n.includes('seche') ||
      n.includes('radiateur')
    ) {
      return palette('hp', 'towel-heater');
    }
    return palette('primary', 'plug');
  });
</script>

<button
  type="button"
  class="switch-tile flex w-full flex-col items-center justify-center gap-1 rounded-[var(--radius-xl)] border p-3 sm:flex-row sm:justify-start sm:gap-3 sm:text-left"
  class:opacity-50={!sw.available}
  style="background: var(--color-card); border-color: var(--color-border); --neon: {style.color}; --neon-glow: {style.glow}; --neon-mid: {style.mid}; --neon-soft: {style.soft};"
  role="switch"
  aria-checked={displayedOn}
  aria-label="Basculer {sw.name}"
  onclick={onToggle}
  onkeydown={onKeydown}
  disabled={!sw.available}
>
  <!-- Icône sémantique colorée -->
  <span
    class="switch-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
    style="background: {displayedOn ? style.color : style.offMuted}; color: {displayedOn
      ? 'white'
      : style.offColor};"
    aria-hidden="true"
  >
    {#if style.glyph === 'ev-charger'}
      <!-- Prise EV / chargeur (éclair dans une borne) -->
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
        <path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" />
      </svg>
    {:else if style.glyph === 'monitor'}
      <!-- Écran multimédia -->
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
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    {:else if style.glyph === 'towel-heater'}
      <!-- Sèche-serviette : radiateur vertical -->
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
        <line x1="6" y1="3" x2="6" y2="21" />
        <line x1="18" y1="3" x2="18" y2="21" />
        <line x1="6" y1="7" x2="18" y2="7" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="6" y1="17" x2="18" y2="17" />
      </svg>
    {:else}
      <!-- Prise classique -->
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
        <path d="M9 2v6M15 2v6" />
        <path d="M5 8h14v3a7 7 0 01-14 0V8z" />
        <path d="M12 18v4" />
      </svg>
    {/if}
  </span>

  <div class="flex min-w-0 flex-col items-center gap-0.5 sm:flex-1 sm:items-start">
    <span
      class="switch-name max-w-full truncate text-center text-[11px] leading-tight font-semibold sm:text-left sm:text-[13px]"
      style="color: var(--color-fg);"
    >
      {sw.name}
    </span>
    <span
      class="hidden text-[10px] font-semibold tracking-[0.04em] uppercase sm:block"
      style:color={displayedOn ? style.color : 'var(--color-muted-fg)'}
    >
      {displayedOn ? 'On' : 'Off'}
    </span>
  </div>
</button>

<style>
  .switch-tile {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .switch-tile:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  .switch-tile:active:not(:disabled) {
    transform: scale(0.99);
  }
  .switch-tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .switch-tile:disabled {
    cursor: not-allowed;
  }

  /* ─── Lueur néon quand ON ─── */
  .switch-tile[aria-checked='true'] {
    border-color: var(--neon);
    box-shadow:
      0 0 14px var(--neon-glow),
      0 0 32px var(--neon-soft);
  }
  .switch-tile[aria-checked='true'] .switch-icon {
    box-shadow:
      0 0 10px var(--neon-glow),
      0 0 20px var(--neon-soft);
  }
  .switch-icon {
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }

  /* Vue iPhone : tuile ALLUMÉE = bouton coloré EN RELIEF (verre bombé, lumière haut-gauche).
     Sheen diagonal (reflet haut-gauche → ombre bas-droite) + arêtes internes + halo coloré
     porté → effet bouton physique rétro-éclairé, jamais une couleur « plate ». */
  @media (max-width: 639px) {
    .switch-tile[aria-checked='true'] {
      border-color: var(--neon);
      background-color: var(--neon) !important;
      background-image: linear-gradient(
        135deg,
        oklch(1 0 0 / 0.32) 0%,
        oklch(1 0 0 / 0.08) 30%,
        transparent 52%,
        oklch(0.1 0.01 286 / 0.16) 100%
      ) !important;
      box-shadow:
        inset 0 1px 0.5px oklch(1 0 0 / 0.55),
        inset 1.5px 1.5px 2px oklch(1 0 0 / 0.22),
        inset -1px -2px 6px oklch(0.1 0.01 286 / 0.2),
        0 7px 18px -3px var(--neon-glow),
        0 2px 6px var(--neon-mid);
    }
    .switch-tile[aria-checked='true'] .switch-icon {
      background: oklch(1 0 0 / 0.25) !important;
      color: #fff !important;
      box-shadow:
        inset 0 1px 0 oklch(1 0 0 / 0.45),
        0 2px 4px oklch(0.1 0.01 286 / 0.2) !important;
    }
    .switch-tile[aria-checked='true'] .switch-name {
      color: #fff !important;
    }
  }
</style>
