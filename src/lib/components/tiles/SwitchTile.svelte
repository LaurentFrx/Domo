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
</script>

<button
  type="button"
  class="switch-tile flex w-full items-center justify-between gap-3 rounded-[var(--radius-xl)] border p-3 text-left"
  class:opacity-50={!sw.available}
  style="background: var(--color-card); border-color: var(--color-border);"
  role="switch"
  aria-checked={displayedOn}
  aria-label="Basculer {sw.name}"
  onclick={onToggle}
  onkeydown={onKeydown}
  disabled={!sw.available}
>
  <div class="flex min-w-0 flex-col gap-0.5">
    <span class="text-[12px] font-semibold leading-tight truncate" style="color: var(--color-fg);">
      {sw.name}
    </span>
    <span
      class="text-[10px] font-semibold tracking-[0.04em] uppercase"
      style:color={displayedOn ? 'var(--color-primary)' : 'var(--color-muted-fg)'}
    >
      {displayedOn ? 'On' : 'Off'}
    </span>
  </div>

  <span class="toggle-track shrink-0" class:toggle-on={displayedOn}>
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
    background: var(--color-primary);
    border-color: var(--color-primary);
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
