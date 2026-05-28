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
  import { haptic } from '$utils/haptic';

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

  // Mobile : total réel. sm+ : on exclut les volets (déplacés dans la strip globale).
  const total = $derived(shutters.length + switches.length + zigbeeDevices.length);
  const totalNoShutters = $derived(switches.length + zigbeeDevices.length);

  function fmtCount(n: number): string {
    return n > 1 ? `${n} appareils` : `${n} appareil`;
  }

  const hasShutters = $derived(shutters.length > 0);
  const hasSwitches = $derived(switches.length > 0);
  const hasPlugs = $derived(plugs.length > 0);
  const zigbeeOnable = $derived(
    [...plugs, ...others].filter((d) => typeof d.state.state === 'string')
  );

  /** Affiche les pills "Tout ON/OFF" uniquement si ≥2 toggleables. */
  const showAllOnOff = $derived(switches.length + zigbeeOnable.length >= 2);

  function zigbeeAllOn() {
    for (const d of zigbeeOnable) zigbee.setState(d.friendlyName, 'ON');
  }

  function zigbeeAllOff() {
    for (const d of zigbeeOnable) zigbee.setState(d.friendlyName, 'OFF');
  }

  function openRoomTap() {
    haptic('medium');
    matter.openRoom(room);
  }
  function closeRoomTap() {
    haptic('medium');
    matter.closeRoom(room);
  }
  function allOnTap() {
    haptic('medium');
    if (hasSwitches) matter.switchesOnInRoom(room);
    if (zigbeeOnable.length > 0) zigbeeAllOn();
  }
  function allOffTap() {
    haptic('medium');
    if (hasSwitches) matter.switchesOffInRoom(room);
    if (zigbeeOnable.length > 0) zigbeeAllOff();
  }

  /** Sur sm+, les volets sont dans la strip globale en haut de page :
   * si la pièce ne contient QUE des volets, la section devient vide. */
  const onlyShuttersOnTablet = $derived(
    hasShutters && !hasSwitches && zigbeeDevices.length === 0
  );
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  class:sm:hidden={onlyShuttersOnTablet}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <header class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-baseline gap-2">
      <h2
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        {room}
      </h2>
      <!-- Compteur : différent mobile vs sm+ (sm+ exclut les volets) -->
      <span class="text-[10px] sm:hidden" style="color: var(--color-muted-fg);">
        · {fmtCount(total)}
      </span>
      <span class="hidden text-[10px] sm:inline" style="color: var(--color-muted-fg);">
        · {fmtCount(totalNoShutters)}
      </span>
    </div>

    <div class="flex flex-wrap gap-1.5">
      {#if hasShutters}
        <!-- Pills volets : visibles uniquement sur mobile (sm+ utilise la strip) -->
        <button
          type="button"
          class="room-pill pill-shutter"
          onclick={openRoomTap}
          aria-label="Ouvrir tous les volets de {room}"
        >
          Tout ouvrir
        </button>
        <button
          type="button"
          class="room-pill pill-shutter"
          onclick={closeRoomTap}
          aria-label="Fermer tous les volets de {room}"
        >
          Tout fermer
        </button>
      {/if}
      {#if showAllOnOff}
        <button
          type="button"
          class="room-pill"
          onclick={allOnTap}
          aria-label="Allumer tous les interrupteurs de {room}"
        >
          Tout ON
        </button>
        <button
          type="button"
          class="room-pill"
          onclick={allOffTap}
          aria-label="Éteindre tous les interrupteurs de {room}"
        >
          Tout OFF
        </button>
      {/if}
    </div>
  </header>

  {#if hasShutters}
    <!-- Grille volets : visible uniquement sur mobile, sm+ a la strip -->
    <div class="grid grid-cols-2 gap-2 sm:hidden">
      {#each shutters as shutter (shutter.nodeId)}
        <ShutterTile {shutter} />
      {/each}
    </div>
  {/if}

  {#if (hasShutters && (hasSwitches || zigbeeDevices.length > 0)) || (hasSwitches && zigbeeDevices.length > 0)}
    <div class="h-px w-full" style="background: var(--color-border);" aria-hidden="true"></div>
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
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--color-muted-fg);
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-default);
    -webkit-tap-highlight-color: transparent;
  }
  .room-pill:hover {
    background: var(--color-primary-muted);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .room-pill:active {
    transform: scale(0.97);
  }
  /* Pills volets : masquées sur sm+ (les volets sont dans la strip globale) */
  @media (min-width: 640px) {
    .pill-shutter {
      display: none;
    }
  }
</style>
