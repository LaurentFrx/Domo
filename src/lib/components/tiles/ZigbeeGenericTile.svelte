<script lang="ts">
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
  type Glyph = 'bulb' | 'light-switch' | 'cover' | 'plug';

  const style = $derived.by<{ glyph: Glyph; color: string; muted: string }>(() => {
    const n = device.friendlyName.toLowerCase();
    if (isCover || n.includes('portail') || n.includes('porte')) {
      return {
        glyph: 'cover',
        color: 'var(--color-grid-energy)',
        muted: 'var(--color-grid-energy-muted)'
      };
    }
    if (isLight || n.includes('lumiere') || n.includes('lumière') || n.includes('atelier') || n.includes('bulb') || n.includes('lampe')) {
      return {
        glyph: 'bulb',
        color: 'var(--color-solar)',
        muted: 'var(--color-solar-muted)'
      };
    }
    if (isSwitch) {
      return {
        glyph: 'light-switch',
        color: 'var(--color-primary)',
        muted: 'var(--color-primary-muted)'
      };
    }
    return {
      glyph: 'plug',
      color: 'var(--color-primary)',
      muted: 'var(--color-primary-muted)'
    };
  });

  function onPulse() {
    if (!device.available) return;
    haptic('medium');
    zigbee.pulse(device.friendlyName);
  }

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
  <!-- Cover (Portail) : impulsion via bouton dédié, pas de toggle -->
  <div
    class="generic-tile flex w-full items-center gap-3 rounded-[var(--radius-xl)] border p-3"
    class:opacity-50={!device.available}
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <span
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {style.muted}; color: {style.color};"
      aria-hidden="true"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="3" width="16" height="18" rx="1.5" />
        <line x1="4" y1="8" x2="20" y2="8" />
        <line x1="4" y1="13" x2="20" y2="13" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    </span>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[13px] font-semibold leading-tight truncate" style="color: var(--color-fg);">
        {displayName}
      </span>
      <span class="text-[10px] truncate" style="color: var(--color-muted-fg);">
        {device.vendor} · {device.model}
      </span>
    </div>
    <button
      type="button"
      class="cover-btn shrink-0"
      onclick={onPulse}
      disabled={!device.available}
      aria-label="Impulsion {displayName}"
    >
      Impulsion
    </button>
  </div>
{:else}
  <!-- Switch / Light : template SwitchTile (icône + toggle + glow ON) -->
  <button
    type="button"
    class="generic-tile flex w-full items-center gap-3 rounded-[var(--radius-xl)] border p-3 text-left"
    class:opacity-50={!device.available}
    style="background: var(--color-card); border-color: var(--color-border); --neon: {style.color};"
    role="switch"
    aria-checked={isOn}
    aria-label="Basculer {displayName}"
    onclick={onToggle}
    onkeydown={onKeydown}
    disabled={!device.available}
  >
    <span
      class="generic-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
      style="background: {isOn ? style.color : style.muted}; color: {isOn ? 'white' : style.color};"
      aria-hidden="true"
    >
      {#if style.glyph === 'bulb'}
        <!-- Ampoule -->
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 1 4 12.8c-.6.5-1 1.2-1 2v1H9v-1c0-.8-.4-1.5-1-2A7 7 0 0 1 12 2z" />
        </svg>
      {:else if style.glyph === 'light-switch'}
        <!-- Interrupteur mural -->
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <rect x="9" y="8" width="6" height="8" rx="1" fill="currentColor" stroke="none" opacity="0.8" />
        </svg>
      {:else}
        <!-- Prise par défaut -->
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 2v6M15 2v6" />
          <path d="M5 8h14v3a7 7 0 01-14 0V8z" />
          <path d="M12 18v4" />
        </svg>
      {/if}
    </span>

    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[13px] font-semibold leading-tight truncate" style="color: var(--color-fg);">
        {displayName}
      </span>
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style:color={isOn ? style.color : 'var(--color-muted-fg)'}
      >
        {isOn ? 'On' : 'Off'}
      </span>
    </div>

    <span
      class="toggle-track shrink-0"
      class:toggle-on={isOn}
      style:--toggle-on-color={style.color}
    >
      <span class="toggle-knob"></span>
    </span>
  </button>

  {#if isLight && brightness !== null}
    <input
      type="range"
      min="0"
      max="254"
      value={brightness}
      oninput={(e) =>
        zigbee.setBrightness(device.friendlyName, +(e.currentTarget as HTMLInputElement).value)}
      class="brightness-range mt-2"
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

  /* ─── Lueur néon quand ON (idem SwitchTile) ─── */
  .generic-tile[aria-checked='true'] {
    border-color: var(--neon);
    box-shadow:
      0 0 14px color-mix(in oklch, var(--neon) 50%, transparent),
      0 0 32px color-mix(in oklch, var(--neon) 22%, transparent);
  }
  .generic-tile[aria-checked='true'] .generic-icon {
    box-shadow:
      0 0 10px color-mix(in oklch, var(--neon) 55%, transparent),
      0 0 20px color-mix(in oklch, var(--neon) 30%, transparent);
  }
  .generic-icon {
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default),
      box-shadow var(--duration-normal) var(--ease-default);
  }

  /* ─── Toggle ─── */
  .toggle-track {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
  }
  .toggle-on {
    background: var(--toggle-on-color, var(--color-primary));
    border-color: var(--toggle-on-color, var(--color-primary));
  }
  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px oklch(0 0 0 / 0.2);
    transform: translateY(-50%);
    transition: left var(--duration-normal) var(--ease-spring);
  }
  .toggle-on .toggle-knob {
    left: calc(100% - 21px);
  }

  /* ─── Cover impulsion ─── */
  .cover-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    background: var(--color-primary);
    color: var(--color-primary-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--duration-fast) var(--ease-default),
      transform var(--duration-fast) var(--ease-default);
  }
  .cover-btn:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .cover-btn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .cover-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
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
