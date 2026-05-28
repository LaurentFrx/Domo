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
  class="flex flex-col gap-2 rounded-[var(--radius-xl)] border p-3"
  class:opacity-50={!device.available}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex items-start justify-between gap-2">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span
        class="text-[12px] font-semibold leading-tight truncate"
        style="color: var(--color-fg);"
      >
        {device.friendlyName}
      </span>
      <span class="text-[10px] truncate" style="color: var(--color-muted-fg);">
        {device.vendor} · {device.model}
      </span>
    </div>
    {#if isSwitch || isLight}
      <span
        class="shrink-0 text-[10px] font-semibold tracking-[0.04em] uppercase"
        style:color={isOn ? 'var(--color-primary)' : 'var(--color-muted-fg)'}
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
        width="13"
        height="13"
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
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    border-radius: 9999px;
    background: var(--color-primary);
    color: var(--color-primary-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
    transition:
      background var(--duration-fast) var(--ease-default),
      transform var(--duration-fast) var(--ease-default);
  }
  .cover-btn:hover {
    background: var(--color-primary-hover);
  }
  .cover-btn:active {
    transform: scale(0.96);
  }
  .cover-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .generic-toggle {
    position: relative;
    width: 46px;
    height: 24px;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--duration-normal) var(--ease-default),
      border-color var(--duration-normal) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
    align-self: flex-start;
  }
  .generic-toggle.on {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .generic-toggle:disabled {
    cursor: not-allowed;
  }
  .generic-knob {
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
  .generic-toggle.on .generic-knob {
    left: calc(100% - 21px);
  }

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
