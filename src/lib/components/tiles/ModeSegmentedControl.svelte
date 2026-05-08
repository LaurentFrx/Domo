<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import type { CumulusMode } from '$theme/tokens';

  const modes: CumulusMode[] = ['OFF', 'PV', 'HC', 'FORCE'];

  function modeStyle(mode: CumulusMode, isActive: boolean): string {
    if (!isActive) {
      return 'background-color: rgba(48, 45, 58, 0.5); color: var(--text-secondary); border-color: transparent;';
    }
    switch (mode) {
      case 'PV':
        return 'background-color: var(--accent-500); color: var(--surface-base); border-color: transparent;';
      case 'HC':
        return 'background-color: rgba(110, 69, 255, 0.15); color: var(--mode-hc); border-color: var(--mode-hc);';
      case 'FORCE':
        return 'background-color: rgba(141, 108, 255, 0.15); color: var(--mode-force); border-color: var(--mode-force);';
      default:
        return 'background-color: rgba(152, 149, 161, 0.4); color: var(--text-primary); border-color: transparent;';
    }
  }
</script>

<div class="flex gap-1.5">
  {#each modes as mode (mode)}
    <button
      type="button"
      class="flex-1 rounded-full border py-2 text-xs font-medium transition-colors"
      style={modeStyle(mode, dashboard.cumulusMode === mode)}
      onclick={() => dashboard.setCumulusMode(mode)}
    >
      {mode}
    </button>
  {/each}
</div>
