<script lang="ts">
  import { onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Switch } from '$stores/matter.svelte';

  interface Props {
    sw: Switch;
  }

  let { sw }: Props = $props();

  // ─── Optimistic toggle ───
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
</script>

<div
  class="switch-tile relative flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
  class:opacity-50={!sw.available}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Header -->
  <div class="flex items-start justify-between">
    <span class="text-[13px] font-semibold leading-tight" style="color: var(--color-fg);">
      {sw.name}
    </span>
    <div class="flex items-center gap-1.5">
      <span
        class="text-[10px] font-semibold tracking-[0.04em] uppercase"
        style:color={displayedOn ? 'var(--color-primary)' : 'var(--color-muted-fg)'}
      >
        {displayedOn ? 'On' : 'Off'}
      </span>
      <span
        class="h-1.5 w-1.5 rounded-full"
        style:background-color={sw.available ? 'var(--color-battery)' : 'var(--color-muted-fg)'}
      ></span>
    </div>
  </div>

  <!-- Toggle pill -->
  <div class="flex items-center justify-center py-2">
    <button
      type="button"
      class="toggle-track"
      class:toggle-on={displayedOn}
      disabled={!sw.available}
      role="switch"
      aria-checked={displayedOn}
      aria-label="Basculer {sw.name}"
      onclick={onToggle}
      onkeydown={onKeydown}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>
</div>

<style>
  .switch-tile {
    transition: border-color var(--duration-normal) var(--ease-default);
  }
  .switch-tile:hover {
    border-color: var(--color-border-strong);
  }

  .toggle-track {
    position: relative;
    width: 76px;
    height: 38px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
  }
  .toggle-track:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }
  .toggle-track:disabled {
    cursor: not-allowed;
  }
  .toggle-track.toggle-on {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 3px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow:
      0 2px 6px oklch(0 0 0 / 0.15),
      0 1px 2px oklch(0 0 0 / 0.1);
    transform: translateY(-50%);
    transition: left var(--duration-normal) var(--ease-spring);
    pointer-events: none;
  }
  .toggle-on .toggle-knob {
    left: calc(100% - 33px);
  }
</style>
