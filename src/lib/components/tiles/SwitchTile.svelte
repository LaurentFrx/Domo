<script lang="ts">
  import { onDestroy } from 'svelte';
  import { matter } from '$stores/matter.svelte';
  import type { Switch } from '$stores/matter.svelte';

  interface Props {
    sw: Switch;
  }

  let { sw }: Props = $props();

  // ─── Optimistic toggle ───
  // Les Sonoff Smart Plug peuvent mettre 200-400 ms à confirmer l'état.
  // On bascule visuellement immédiatement, puis on s'aligne sur la vérité
  // serveur dès qu'elle arrive. Filet de sécurité : si rien ne revient
  // dans 5 s, on retombe sur sw.isOn pour éviter de mentir indéfiniment.
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
    // Le serveur confirme un nouvel état → on libère l'optimisme.
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
  class="tile-glass relative flex flex-col gap-2 overflow-hidden rounded-xl p-3 md:gap-3 md:rounded-2xl md:p-4"
  class:opacity-50={!sw.available}
>
  <div class="glow" class:glow-on={displayedOn} aria-hidden="true"></div>

  <!-- Header : nom + état + pastille statut -->
  <div class="relative flex items-start justify-between">
    <span class="text-sm leading-tight font-medium text-white">{sw.name}</span>
    <div class="flex items-center gap-1.5">
      <span
        class="text-[10px] font-semibold tracking-wider uppercase"
        style:color={displayedOn ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      >
        {displayedOn ? 'On' : 'Off'}
      </span>
      <span
        class="h-2 w-2 rounded-full"
        style:background-color={sw.available ? 'var(--accent-500)' : 'var(--text-tertiary)'}
      ></span>
    </div>
  </div>

  <!-- Toggle pill -->
  <div class="relative flex items-center justify-center py-3">
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
  /* ─── Card en verre Yeldra (calque ShutterTile) ─── */
  .tile-glass {
    background: linear-gradient(135deg, rgba(48, 45, 58, 0.85) 0%, rgba(48, 45, 58, 0.65) 100%);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border: 1px solid var(--border-subtle);
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transition:
      box-shadow var(--motion-base) var(--easing-default),
      transform var(--motion-base) var(--easing-default);
  }

  .tile-glass:hover {
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.45),
      0 0 24px rgba(61, 253, 152, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  .glow {
    position: absolute;
    top: -40px;
    right: -40px;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.04), transparent 70%);
    pointer-events: none;
    z-index: 0;
    transition: background var(--motion-base) var(--easing-default);
  }

  .glow-on {
    background: radial-gradient(circle, rgba(61, 253, 152, 0.22), transparent 70%);
  }

  /* ─── Toggle pill ─── */
  .toggle-track {
    position: relative;
    width: 88px;
    height: 44px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 4px 12px rgba(0, 0, 0, 0.5);
    cursor: pointer;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color var(--motion-base) var(--easing-default),
      border-color var(--motion-base) var(--easing-default),
      box-shadow var(--motion-base) var(--easing-default);
  }

  .toggle-track:focus-visible {
    outline: 2px solid var(--accent-500);
    outline-offset: 3px;
  }

  .toggle-track:disabled {
    cursor: not-allowed;
  }

  .toggle-track.toggle-on {
    background: linear-gradient(135deg, var(--accent-600), var(--accent-500));
    border-color: rgba(141, 253, 195, 0.4);
    box-shadow:
      inset 0 2px 6px rgba(0, 0, 0, 0.25),
      0 0 16px rgba(61, 253, 152, 0.5),
      0 0 32px rgba(61, 253, 152, 0.25);
  }

  .toggle-knob {
    position: absolute;
    top: 50%;
    left: 4px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff, #e8e6f0);
    box-shadow:
      0 4px 10px rgba(0, 0, 0, 0.55),
      inset 0 -2px 4px rgba(0, 0, 0, 0.12);
    transform: translateY(-50%);
    transition:
      left var(--motion-base) var(--easing-default),
      box-shadow var(--motion-base) var(--easing-default);
    pointer-events: none;
  }

  .toggle-on .toggle-knob {
    left: calc(100% - 40px);
    box-shadow:
      0 4px 14px rgba(0, 0, 0, 0.6),
      0 0 18px rgba(61, 253, 152, 0.55),
      inset 0 -2px 4px rgba(0, 0, 0, 0.12);
  }
</style>
