<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import { haptic } from '$utils/haptic';

  interface Props {
    device: ZigbeeDevice;
  }

  let { device }: Props = $props();

  const isCover = $derived(device.category === 'cover');
  const isSwitch = $derived(device.category === 'switch');
  const isLight = $derived(device.category === 'light');
  const isOn = $derived(device.state.state === 'ON');

  const brightness = $derived<number | null>(
    typeof device.state.brightness === 'number' ? (device.state.brightness as number) : null
  );

  // ─── Override d'affichage pour les noms peu parlants ───
  const DISPLAY_NAMES: Record<string, string> = {
    lumiere_atelier: 'Atelier'
  };
  const displayName = $derived(
    DISPLAY_NAMES[device.friendlyName.toLowerCase()] ?? device.friendlyName
  );

  // ─── Style sémantique (icône + couleur) selon le nom et la catégorie ───
  // glow* = halos box-shadow pré-calculés (tokens app.css) — jamais de
  // color-mix() dans une box-shadow via var() (piège Chrome).
  type Glyph = 'bulb' | 'light-switch' | 'cover' | 'plug';
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
    const n = device.friendlyName.toLowerCase();
    if (isCover || n.includes('portail') || n.includes('porte')) {
      // Éteint : logo bleu (charte) ; impulsion : couleur d'origine conservée.
      return palette('grid-energy', 'cover', 'consumption');
    }
    if (
      isLight ||
      n.includes('lumiere') ||
      n.includes('lumière') ||
      n.includes('atelier') ||
      n.includes('bulb') ||
      n.includes('lampe')
    ) {
      // Éteint : logo bleu (charte) ; allumé : ambre « solaire » conservé.
      return palette('solar', 'bulb', 'consumption');
    }
    if (isSwitch) {
      return palette('primary', 'light-switch');
    }
    return palette('primary', 'plug');
  });

  // Impulsion (portail) : le device n'a pas d'état durable → on « allume » la tuile
  // 3 s en visuel (bouton coloré en relief) puis retour à l'état initial.
  let pulsing = $state(false);
  let pulseError = $state(false);
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  async function onPulse() {
    if (!device.available) return;
    haptic('medium');
    pulseError = false;
    pulsing = true;
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      pulsing = false;
      pulseTimer = null;
    }, 3000);
    if (device.friendlyName === 'Portail') {
      try {
        // On ATTEND la réponse : un glow vert ne doit pas mentir si la commande
        // n'est pas passée (tunnel MQTT mort → 503, rate-limit → 429…).
        const r = await fetch('/api/portail/pulse', {
          method: 'POST',
          headers: { 'x-domo-app': '1' }
        });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || `HTTP ${r.status}`);
        }
      } catch (e) {
        // Échec réel : on annule le faux succès et on le signale clairement.
        if (pulseTimer) clearTimeout(pulseTimer);
        pulseTimer = null;
        pulsing = false;
        pulseError = true;
        haptic('heavy');
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(() => {
          pulseError = false;
          errorTimer = null;
        }, 3500);
        console.error('Portail pulse échec', e);
      }
    }
  }
  onDestroy(() => {
    if (pulseTimer) clearTimeout(pulseTimer);
    if (errorTimer) clearTimeout(errorTimer);
  });

  function onToggle() {
    if (!device.available) return;
    haptic('light');
    zigbee.toggle(device.friendlyName);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onToggle();
    }
  }
</script>

{#if isCover}
  <!-- Cover (Portail) : la carte ENTIÈRE est le bouton d'impulsion ; s'allume 3 s (relief). -->
  <div
    class="generic-tile flex w-full flex-col items-center justify-center gap-1.5 rounded-[var(--radius-xl)] border px-3 py-2 sm:flex-row sm:justify-start sm:gap-3"
    class:opacity-50={!device.available}
    class:pulsing
    class:error={pulseError}
    style="background: var(--color-card); border-color: var(--color-border); --neon: {style.color}; --neon-glow: {style.glow}; --neon-mid: {style.mid}; --neon-soft: {style.soft};"
    role="button"
    tabindex={device.available ? 0 : -1}
    onclick={onPulse}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPulse();
      }
    }}
  >
    <span
      class="generic-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {pulsing ? style.color : style.offMuted}; color: {pulsing
        ? 'white'
        : style.offColor};"
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
        <rect x="4" y="3" width="16" height="18" rx="1.5" />
        <line x1="4" y1="8" x2="20" y2="8" />
        <line x1="4" y1="13" x2="20" y2="13" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    </span>
    <div class="flex min-w-0 flex-col items-center gap-0.5 sm:flex-1 sm:items-start">
      <span
        class="generic-name max-w-full truncate text-center text-[11px] leading-tight font-semibold sm:text-left sm:text-[13px]"
        style="color: {pulseError ? 'var(--color-alert)' : 'var(--color-fg)'};"
      >
        {pulseError ? 'Échec — réessayer' : displayName}
      </span>
      <span class="hidden truncate text-[10px] sm:block" style="color: var(--color-muted-fg);">
        {device.vendor} · {device.model}
      </span>
    </div>
  </div>
{:else}
  <!-- Switch / Light : la carte ENTIÈRE bascule l'état (plus de toggle), vive quand ON. -->
  <button
    type="button"
    class="generic-tile flex w-full flex-col items-center justify-center gap-1.5 rounded-[var(--radius-xl)] border px-3 py-2 sm:flex-row sm:justify-start sm:gap-3 sm:text-left"
    class:opacity-50={!device.available}
    style="background: var(--color-card); border-color: var(--color-border); --neon: {style.color}; --neon-glow: {style.glow}; --neon-mid: {style.mid}; --neon-soft: {style.soft};"
    role="switch"
    aria-checked={isOn}
    aria-label="Basculer {displayName}"
    onclick={onToggle}
    onkeydown={onKeydown}
    disabled={!device.available}
  >
    <span
      class="generic-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn ? style.color : style.offMuted}; color: {isOn
        ? 'white'
        : style.offColor};"
      aria-hidden="true"
    >
      {#if style.glyph === 'bulb'}
        <!-- Ampoule -->
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
      {:else if style.glyph === 'light-switch'}
        <!-- Interrupteur mural -->
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
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <rect
            x="9"
            y="8"
            width="6"
            height="8"
            rx="1"
            fill="currentColor"
            stroke="none"
            opacity="0.8"
          />
        </svg>
      {:else}
        <!-- Prise par défaut -->
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
        class="generic-name max-w-full truncate text-center text-[11px] leading-tight font-semibold sm:text-left sm:text-[13px]"
        style="color: var(--color-fg);"
      >
        {displayName}
      </span>
      <span
        class="hidden text-[10px] font-semibold tracking-[0.04em] uppercase sm:block"
        style:color={isOn ? style.color : 'var(--color-muted-fg)'}
      >
        {isOn ? 'On' : 'Off'}
      </span>
    </div>
  </button>

  {#if isLight && brightness !== null}
    <input
      type="range"
      min="0"
      max="254"
      value={brightness}
      oninput={(e) =>
        zigbee.setBrightness(device.friendlyName, +(e.currentTarget as HTMLInputElement).value)}
      class="brightness-range mt-2 hidden sm:block"
    />
  {/if}
{/if}

<style>
  .generic-tile {
    transition:
      border-color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .generic-tile:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }
  button.generic-tile:active:not(:disabled) {
    transform: scale(0.99);
  }
  .generic-tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .generic-tile:disabled {
    cursor: not-allowed;
  }

  /* Échec de commande (portail) : la tuile NE MENT PAS — bordure d'alerte + halo
     rouge bref. oklch DIRECT (safe Chrome). Prime sur le glow de succès. */
  .generic-tile.error {
    border-color: var(--color-alert) !important;
    box-shadow:
      inset 0 0 0 1px var(--color-alert),
      0 6px 16px -6px oklch(0.55 0.24 27 / 0.5) !important;
    background-image: none !important;
    background-color: var(--color-card) !important;
  }

  /* ─── Lueur néon quand ON / impulsion portail active (idem SwitchTile) ─── */
  .generic-tile:is([aria-checked='true'], .pulsing) {
    border-color: var(--neon);
    box-shadow:
      0 0 14px var(--neon-glow),
      0 0 32px var(--neon-soft);
  }
  .generic-tile:is([aria-checked='true'], .pulsing) .generic-icon {
    box-shadow:
      0 0 10px var(--neon-glow),
      0 0 20px var(--neon-soft);
  }
  .generic-icon {
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }

  /* Vue iPhone : tuile ALLUMÉE (ou impulsion portail) = bouton coloré EN RELIEF.
     Même recette que SwitchTile : sheen haut-gauche, arêtes internes, halo porté. */
  @media (max-width: 639px) {
    .generic-tile:is([aria-checked='true'], .pulsing) {
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
    .generic-tile:is([aria-checked='true'], .pulsing) .generic-icon {
      background: oklch(1 0 0 / 0.25) !important;
      color: #fff !important;
      box-shadow:
        inset 0 1px 0 oklch(1 0 0 / 0.45),
        0 2px 4px oklch(0.1 0.01 286 / 0.2) !important;
    }
    .generic-tile:is([aria-checked='true'], .pulsing) .generic-name {
      color: #fff !important;
    }
  }

  /* ─── Brightness range (lights dimmables) ─── */
  .brightness-range {
    width: 100%;
    height: 4px;
    appearance: none;
    background: var(--color-muted);
    border-radius: 9999px;
    cursor: pointer;
  }
  .brightness-range::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-primary);
    cursor: pointer;
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.2);
  }
</style>
