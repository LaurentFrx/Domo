<script lang="ts">
  import type { Shutter, Switch as MatterSwitch } from '$stores/matter.svelte';
  import { matter } from '$stores/matter.svelte';
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';
  import { zigbee } from '$stores/zigbee.svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';
  import ZigbeeSensorTile from '$components/tiles/ZigbeeSensorTile.svelte';
  import ZigbeePlugTile from '$components/tiles/ZigbeePlugTile.svelte';
  import ZigbeeGenericTile from '$components/tiles/ZigbeeGenericTile.svelte';

  interface Props {
    room: string;
    shutters: Shutter[];
    switches: MatterSwitch[];
    zigbeeDevices: ZigbeeDevice[];
  }

  let { room, shutters, switches, zigbeeDevices }: Props = $props();

  const sensors = $derived(zigbeeDevices.filter((d) => d.category === 'sensor'));
  const plugs = $derived(zigbeeDevices.filter((d) => d.category === 'plug'));
  const others = $derived(zigbeeDevices.filter((d) => !['sensor', 'plug'].includes(d.category)));

  const total = $derived(shutters.length + switches.length + zigbeeDevices.length);
  const deviceLabel = $derived(total > 1 ? `${total} appareils` : `${total} appareil`);

  const hasShutters = $derived(shutters.length > 0);
  const hasSwitches = $derived(switches.length > 0);
  const hasPlugs = $derived(plugs.length > 0);
  const zigbeeOnable = $derived(
    [...plugs, ...others].filter((d) => typeof d.state.state === 'string')
  );

  function zigbeeAllOn() {
    for (const d of zigbeeOnable) zigbee.setState(d.friendlyName, 'ON');
  }

  function zigbeeAllOff() {
    for (const d of zigbeeOnable) zigbee.setState(d.friendlyName, 'OFF');
  }

  const hasAnyToggleable = $derived(hasSwitches || zigbeeOnable.length > 0);
</script>

<section
  class="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 shadow-[var(--shadow-card)] md:gap-3 md:rounded-2xl md:p-3"
>
  <header class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-baseline gap-2">
      <h2 class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
        {room.toUpperCase()}
      </h2>
      <span class="text-[10px] text-[var(--text-tertiary)]">·&nbsp;{deviceLabel}</span>
    </div>

    <div class="flex flex-wrap gap-1.5">
      {#if hasShutters}
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.openRoom(room)}
          aria-label="Ouvrir tous les volets de {room}"
        >
          Tout ouvrir
        </button>
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.closeRoom(room)}
          aria-label="Fermer tous les volets de {room}"
        >
          Tout fermer
        </button>
      {/if}
      {#if hasAnyToggleable}
        <button
          type="button"
          class="room-pill"
          onclick={() => {
            if (hasSwitches) matter.switchesOnInRoom(room);
            if (zigbeeOnable.length > 0) zigbeeAllOn();
          }}
          aria-label="Allumer tous les interrupteurs de {room}"
        >
          Tout ON
        </button>
        <button
          type="button"
          class="room-pill"
          onclick={() => {
            if (hasSwitches) matter.switchesOffInRoom(room);
            if (zigbeeOnable.length > 0) zigbeeAllOff();
          }}
          aria-label="Éteindre tous les interrupteurs de {room}"
        >
          Tout OFF
        </button>
      {/if}
    </div>
  </header>

  {#if hasShutters}
    <div class="grid grid-cols-2 gap-2">
      {#each shutters as shutter (shutter.nodeId)}
        <ShutterTile {shutter} />
      {/each}
    </div>
  {/if}

  {#if (hasShutters && (hasSwitches || zigbeeDevices.length > 0)) || (hasSwitches && zigbeeDevices.length > 0)}
    <div class="h-px w-full bg-white/[0.06]" aria-hidden="true"></div>
  {/if}

  {#if hasSwitches}
    <div class="grid grid-cols-2 gap-2">
      {#each switches as sw (sw.nodeId)}
        <SwitchTile {sw} />
      {/each}
    </div>
  {/if}

  {#if sensors.length > 0}
    <div class="grid grid-cols-2 gap-2">
      {#each sensors as device (device.ieee)}
        <ZigbeeSensorTile {device} />
      {/each}
    </div>
  {/if}

  {#if hasPlugs}
    <div class="grid grid-cols-2 gap-2">
      {#each plugs as device (device.ieee)}
        <ZigbeePlugTile {device} />
      {/each}
    </div>
  {/if}

  {#if others.length > 0}
    <div class="grid grid-cols-2 gap-2">
      {#each others as device (device.ieee)}
        <ZigbeeGenericTile {device} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .room-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    font-size: 10px;
    font-weight: 500;
    line-height: 1.2;
    color: var(--text-secondary);
    background: var(--border-default);
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--easing-default),
      color var(--motion-fast) var(--easing-default),
      transform var(--motion-fast) var(--easing-default);
    -webkit-tap-highlight-color: transparent;
  }

  .room-pill:hover {
    background: var(--border-strong);
    color: var(--text-primary);
  }

  .room-pill:active {
    transform: scale(0.96);
  }
</style>
