<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';
  import BatteryIcon from '$components/ui/BatteryIcon.svelte';

  const statusLabel = $derived(
    dashboard.batteryStatus === 'charge'
      ? 'Charge active'
      : dashboard.batteryStatus === 'discharge'
        ? 'Décharge'
        : 'Repos'
  );

  const statusColor = $derived(
    dashboard.batteryStatus === 'charge'
      ? 'var(--accent-500)'
      : dashboard.batteryStatus === 'discharge'
        ? 'var(--warning)'
        : 'var(--primary-400)'
  );
</script>

<div
  class="tile-press flex flex-col gap-1.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
>
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">BATTERIE</span>
    <BatteryIcon level={dashboard.batteryLevel} status={dashboard.batteryStatus} size={24} />
  </div>
  <div class="flex items-baseline gap-1">
    <AnimatedValue
      value={dashboard.batteryLevel}
      decimals={0}
      class="text-2xl font-medium text-white tabular-nums"
    />
    <span class="text-xs text-[var(--text-secondary)]">%</span>
  </div>
  <span class="text-[10px] font-medium" style="color: {statusColor};">{statusLabel}</span>
</div>
