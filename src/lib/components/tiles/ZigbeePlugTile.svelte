<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';

  interface Props {
    device: ZigbeeDevice;
  }

  let { device }: Props = $props();

  const isOn = $derived(device.state.state === 'ON');
  const power = $derived<number | null>(
    typeof device.state.power === 'number' ? (device.state.power as number) : null
  );
  const energy = $derived<number | null>(
    typeof device.state.energy === 'number' ? (device.state.energy as number) : null
  );
  const hasStateControl = $derived(typeof device.state.state === 'string');
</script>

<div
  class="tile-press relative flex flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:rounded-2xl md:p-3"
  class:opacity-50={!device.available}
>
  <div class="flex items-start justify-between gap-2">
    <div class="flex flex-col gap-0.5">
      <span class="text-sm leading-tight font-medium text-white">{device.friendlyName}</span>
      <span class="text-[10px] text-[var(--text-tertiary)]">{device.model}</span>
    </div>
    {#if hasStateControl}
      <span
        class="text-[10px] font-semibold tracking-wider uppercase"
        style:color={isOn ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      >
        {isOn ? 'On' : 'Off'}
      </span>
    {/if}
  </div>

  {#if power !== null}
    <div class="flex items-baseline gap-1">
      <span
        class="text-xl font-light tabular-nums md:text-2xl"
        style:color={power > 5 ? 'var(--accent-500)' : 'var(--text-secondary)'}
      >
        {power.toFixed(power < 10 ? 1 : 0)}
      </span>
      <span class="text-[10px] text-[var(--text-secondary)]">W</span>
      {#if energy !== null}
        <span class="ml-auto text-[10px] text-[var(--text-tertiary)] tabular-nums">
          {energy.toFixed(1)} kWh
        </span>
      {/if}
    </div>
  {/if}

  {#if hasStateControl}
    <button
      type="button"
      class="plug-toggle"
      class:on={isOn}
      role="switch"
      aria-checked={isOn}
      aria-label="Basculer {device.friendlyName}"
      onclick={() => zigbee.toggle(device.friendlyName)}
      disabled={!device.available}
    >
      <span class="plug-knob"></span>
    </button>
  {/if}
</div>

<style>
  .plug-toggle {
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
  .plug-toggle.on {
    background: linear-gradient(135deg, var(--accent-600), var(--accent-500));
    border-color: rgba(141, 253, 195, 0.4);
    box-shadow:
      inset 0 2px 4px rgba(0, 0, 0, 0.2),
      0 0 10px rgba(61, 253, 152, 0.4);
  }
  .plug-toggle:disabled {
    cursor: not-allowed;
  }
  .plug-knob {
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
  .plug-toggle.on .plug-knob {
    left: calc(100% - 19px);
  }
</style>
