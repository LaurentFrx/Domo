<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
</script>

<div
  class="flex flex-col gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
>
  <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">SOLAIRE</span>
  <div class="flex items-baseline gap-1">
    <span class="text-2xl font-medium text-[var(--accent-500)]">{dashboard.solarPower}</span>
    <span class="text-xs text-[var(--text-secondary)]">kW</span>
  </div>
  <span class="text-[10px] text-[var(--text-secondary)]">
    Auto-conso {dashboard.solarSelfConsumption}%
  </span>
</div>
