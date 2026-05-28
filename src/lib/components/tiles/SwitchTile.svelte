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
  type Glyph = 'ev-charger' | 'monitor' | 'towel-heater' | 'plug';

  const style = $derived.by<{ glyph: Glyph; color: string; muted: string }>(() => {
    const n = sw.name.toLowerCase();
    if (n.includes('chargeur') || n.includes('charger') || n.includes('ev')) {
      return {
        glyph: 'ev-charger',
        color: 'var(--color-solar)',
        muted: 'var(--color-solar-muted)'
      };
    }
    if (n.includes('multim') || n.includes('bureau') || n.includes('media') || n.includes('écran') || n.includes('ecran')) {
      return {
        glyph: 'monitor',
        color: 'var(--color-consumption)',
        muted: 'var(--color-consumption-muted)'
      };
    }
    if (n.includes('serviette') || n.includes('sèche') || n.includes('seche') || n.includes('radiateur')) {
      return {
        glyph: 'towel-heater',
        color: 'var(--color-hp)',
        muted: 'var(--color-hp-muted)'
      };
    }
    return {
      glyph: 'plug',
      color: 'var(--color-primary)',
      muted: 'var(--color-primary-muted)'
    };
  });
</script>

<button
  type="button"
  class="switch-tile flex w-full items-center gap-3 rounded-[var(--radius-xl)] border p-3 text-left"
  class:opacity-50={!sw.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  role="switch"
  aria-checked={displayedOn}
  aria-label="Basculer {sw.name}"
  onclick={onToggle}
  onkeydown={onKeydown}
  disabled={!sw.available}
>
  <!-- Icône sémantique colorée -->
  <span
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
    style="background: {style.muted}; color: {style.color};"
    aria-hidden="true"
  >
    {#if style.glyph === 'ev-charger'}
      <!-- Prise EV / chargeur (éclair dans une borne) -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" />
      </svg>
    {:else if style.glyph === 'monitor'}
      <!-- Écran multimédia -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    {:else if style.glyph === 'towel-heater'}
      <!-- Sèche-serviette : radiateur vertical -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="3" x2="6" y2="21" />
        <line x1="18" y1="3" x2="18" y2="21" />
        <line x1="6" y1="7" x2="18" y2="7" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="6" y1="17" x2="18" y2="17" />
      </svg>
    {:else}
      <!-- Prise classique -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 2v6M15 2v6" />
        <path d="M5 8h14v3a7 7 0 01-14 0V8z" />
        <path d="M12 18v4" />
      </svg>
    {/if}
  </span>

  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <span class="text-[13px] font-semibold leading-tight truncate" style="color: var(--color-fg);">
      {sw.name}
    </span>
    <span
      class="text-[10px] font-semibold tracking-[0.04em] uppercase"
      style:color={displayedOn ? style.color : 'var(--color-muted-fg)'}
    >
      {displayedOn ? 'On' : 'Off'}
    </span>
  </div>

  <span
    class="toggle-track shrink-0"
    class:toggle-on={displayedOn}
    style:--toggle-on-color={style.color}
  >
    <span class="toggle-knob"></span>
  </span>
</button>

<style>
  .switch-tile {
    transition: border-color var(--duration-normal) var(--ease-default);
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
</style>
