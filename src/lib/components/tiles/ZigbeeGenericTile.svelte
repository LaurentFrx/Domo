<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';

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

  function onPulse() {
    if (!device.available) return;
    zigbee.pulse(device.friendlyName);
  }

  function onToggle() {
    if (!device.available) return;
    zigbee.toggle(device.friendlyName);
  }
</script>

<div
  class="tile-press flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 shadow-[var(--shadow-card)] md:rounded-2xl md:p-3"
  class:opacity-50={!device.available}
>
  <div class="flex items-start justify-between gap-2">
    <div class="flex flex-col gap-0.5">
      <span class="text-sm leading-tight font-medium text-white">{device.friendlyName}</span>
      <span class="text-[10px] text-[var(--text-tertiary)]">{device.vendor} · {device.model}</span>
    </div>
    {#if isSwitch || isLight}
      <span
        class="text-[10px] font-semibold tracking-wider uppercase"
        style:color={isOn ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      >
        {isOn ? 'On' : 'Off'}
      </span>
    {/if}
  </div>

  {#if isCover}
    <button
      type="button"
      class="cover-btn"
      onclick={onPulse}
      disabled={!device.available}
      aria-label="Impulsion {device.friendlyName}"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M5 12 H19 M12 5 V19 M5 5 L19 19 M5 19 L19 5" />
      </svg>
      Impulsion
    </button>
  {:else if isSwitch || isLight}
    <button
      type="button"
      class="generic-toggle"
      class:on={isOn}
      role="switch"
      aria-checked={isOn}
      aria-label="Basculer {device.friendlyName}"
      onclick={onToggle}
      disabled={!device.available}
    >
      <span class="generic-knob"></span>
    </button>
    {#if isLight && brightness !== null}
      <input
        type="range"
        min="0"
        max="254"
        value={brightness}
        oninput={(e) =>
          zigbee.setBrightness(device.friendlyName, +(e.currentTarget as HTMLInputElement).value)}
        class="brightness-range"
      />
    {/if}
  {/if}
</div>

<style>
  .cover-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    border-radius: 9999px;
    background: var(--primary-500);
    color: var(--text-primary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    align-self: flex-start;
    box-shadow: 0 0 14px rgba(110, 69, 255, 0.3);
    transition: transform var(--motion-fast) var(--easing-default);
  }
  .cover-btn:hover {
    background: var(--primary-600);
  }
  .cover-btn:active {
    transform: scale(0.95);
  }
  .cover-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .generic-toggle {
    position: relative;
    width: 44px;
    height: 22px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    padding: 0;
    transition: background-color var(--motion-base) var(--easing-default);
    -webkit-tap-highlight-color: transparent;
    align-self: flex-start;
  }
  .generic-toggle.on {
    background: linear-gradient(135deg, var(--accent-600), var(--accent-500));
    border-color: rgba(141, 253, 195, 0.4);
    box-shadow:
      inset 0 2px 4px rgba(0, 0, 0, 0.2),
      0 0 10px rgba(61, 253, 152, 0.4);
  }
  .generic-toggle:disabled {
    cursor: not-allowed;
  }
  .generic-knob {
    position: absolute;
    top: 50%;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #fff, #e8e6f0);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    transform: translateY(-50%);
    transition: left var(--motion-base) var(--easing-default);
  }
  .generic-toggle.on .generic-knob {
    left: calc(100% - 19px);
  }

  .brightness-range {
    width: 100%;
    height: 3px;
    appearance: none;
    background: var(--border-default);
    border-radius: 9999px;
    cursor: pointer;
  }
  .brightness-range::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent-500);
    cursor: pointer;
  }
</style>
