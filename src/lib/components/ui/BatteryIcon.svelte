<script lang="ts">
  interface Props {
    level: number;
    status: 'charge' | 'discharge' | 'idle';
    size?: number;
  }

  let { level, status, size = 24 }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(100, level)));

  const color = $derived(
    clamped > 60 ? 'var(--accent-500)' : clamped > 25 ? 'var(--warning)' : 'var(--error)'
  );

  const w = 18;
  const h = 10;
  const x = 1;
  const y = 1;
  const inner = $derived((clamped / 100) * (w - 2));
</script>

<svg
  width={size}
  height={(size * 14) / 24}
  viewBox="0 0 24 14"
  fill="none"
  class:charging={status === 'charge'}
>
  <!-- Body -->
  <rect
    {x}
    {y}
    width={w}
    height={h}
    rx="2.5"
    stroke="currentColor"
    stroke-opacity="0.5"
    stroke-width="1"
  />
  <!-- Cap -->
  <rect x="20.5" y="4" width="2" height="6" rx="0.6" fill="currentColor" fill-opacity="0.5" />

  <!-- Inner level -->
  <rect
    x={x + 1}
    y={y + 1}
    width={inner}
    height={h - 2}
    rx="1.5"
    fill={color}
    style="transition: width 0.5s ease-out, fill 0.3s ease-out;"
  />

  {#if status === 'charge'}
    <!-- Bolt -->
    <path
      d="M11 3 L8 8 L11 8 L10 11 L13 6 L10 6 Z"
      fill="var(--surface-base)"
      stroke="currentColor"
      stroke-width="0.5"
      stroke-linejoin="round"
    />
  {/if}
</svg>

<style>
  .charging rect:nth-of-type(3) {
    animation: charge-pulse 1.5s ease-in-out infinite;
  }
</style>
