<script lang="ts">
  import type { DeviceGroup } from '$stores/matter.svelte';
  import { matter } from '$stores/matter.svelte';
  import ShutterTile from '$components/tiles/ShutterTile.svelte';
  import SwitchTile from '$components/tiles/SwitchTile.svelte';

  interface Props {
    room: DeviceGroup;
  }

  let { room }: Props = $props();

  const total = $derived(room.shutters.length + room.switches.length);
  const deviceLabel = $derived(total > 1 ? `${total} appareils` : `${total} appareil`);

  const hasShutters = $derived(room.shutters.length > 0);
  const hasSwitches = $derived(room.switches.length > 0);
  const hasBoth = $derived(hasShutters && hasSwitches);
</script>

<section
  class="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 md:gap-3 md:rounded-2xl md:p-3"
>
  <header class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-baseline gap-2">
      <h2 class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
        {room.room.toUpperCase()}
      </h2>
      <span class="text-[10px] text-[var(--text-tertiary)]">·&nbsp;{deviceLabel}</span>
    </div>

    <div class="flex flex-wrap gap-1.5">
      {#if hasShutters}
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.openRoom(room.room)}
          aria-label="Ouvrir tous les volets de {room.room}"
        >
          Tout ouvrir
        </button>
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.closeRoom(room.room)}
          aria-label="Fermer tous les volets de {room.room}"
        >
          Tout fermer
        </button>
      {/if}
      {#if hasSwitches}
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.switchesOnInRoom(room.room)}
          aria-label="Allumer tous les interrupteurs de {room.room}"
        >
          Tout ON
        </button>
        <button
          type="button"
          class="room-pill"
          onclick={() => matter.switchesOffInRoom(room.room)}
          aria-label="Éteindre tous les interrupteurs de {room.room}"
        >
          Tout OFF
        </button>
      {/if}
    </div>
  </header>

  {#if hasShutters}
    <div class="grid grid-cols-2 gap-2">
      {#each room.shutters as shutter (shutter.nodeId)}
        <div class="tile-press">
          <ShutterTile {shutter} />
        </div>
      {/each}
    </div>
  {/if}

  {#if hasBoth}
    <div class="h-px w-full bg-white/[0.06]" aria-hidden="true"></div>
  {/if}

  {#if hasSwitches}
    <div class="grid grid-cols-2 gap-2">
      {#each room.switches as sw (sw.nodeId)}
        <div class="tile-press">
          <SwitchTile {sw} />
        </div>
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
