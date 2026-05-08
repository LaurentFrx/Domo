<script lang="ts">
  interface Props {
    label: string;
    value: string;
    color?: string;
  }

  let { label, value, color = 'var(--text-primary)' }: Props = $props();
</script>

<div class="flex flex-col gap-0.5">
  <span class="text-xs text-[var(--text-secondary)]">{label}</span>
  <span class="text-sm font-medium" style="color: {color}">{value}</span>
</div>
