<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';

  const statusLabel = $derived(
    dashboard.batteryStatus === 'charge' ? 'Charge active'
    : dashboard.batteryStatus === 'discharge' ? 'Décharge'
    : 'Repos'
  );
</script>

<div class="flex flex-col gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4">
  <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">BATTERIE</span>
  <div class="flex items-baseline gap-1">
    <span class="text-2xl font-medium text-white">{dashboard.batteryLevel}</span>
    <span class="text-xs text-[var(--text-secondary)]">%</span>
  </div>
  <span class="text-[10px] font-medium text-[var(--primary-500)]">{statusLabel}</span>
</div>
