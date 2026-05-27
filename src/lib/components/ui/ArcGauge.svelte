<script lang="ts">
  interface Props {
    value: number;
    size?: number;
    color?: string;
    strokeWidth?: number;
    showValue?: boolean;
    valueSuffix?: string;
  }

  let {
    value,
    size = 120,
    color = 'var(--accent-500)',
    strokeWidth = 6,
    showValue = true,
    valueSuffix = '%'
  }: Props = $props();

  const startAngle = 150;
  const endAngle = 390;
  const sweep = endAngle - startAngle;

  const cx = $derived(size / 2);
  const cy = $derived(size / 2);
  const r = $derived((size - strokeWidth) / 2);

  function polar(angleDeg: number, radius: number, ox: number, oy: number) {
    const a = (angleDeg * Math.PI) / 180;
    return { x: ox + radius * Math.cos(a), y: oy + radius * Math.sin(a) };
  }

  const arcPath = $derived.by(() => {
    const start = polar(startAngle, r, cx, cy);
    const end = polar(endAngle, r, cx, cy);
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  });

  const arcLength = $derived((sweep / 360) * 2 * Math.PI * r);
  const clamped = $derived(Math.max(0, Math.min(100, value)));
  const dashOffset = $derived(arcLength * (1 - clamped / 100));

  const dotAngle = $derived(startAngle + (clamped / 100) * sweep);
  const dot = $derived(polar(dotAngle, r, cx, cy));

  const filterId = `gauge-glow-${Math.random().toString(36).slice(2, 9)}`;
</script>

<div
  class="relative inline-flex items-center justify-center"
  style="width: {size}px; height: {size}px;"
>
  <svg width={size} height={size} viewBox="0 0 {size} {size}" class="overflow-visible">
    <defs>
      <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
      </filter>
    </defs>

    <!-- Background arc -->
    <path
      d={arcPath}
      fill="none"
      stroke="rgba(255,255,255,0.06)"
      stroke-width={strokeWidth}
      stroke-linecap="round"
    />

    <!-- Active arc -->
    <path
      d={arcPath}
      fill="none"
      stroke={color}
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-dasharray={arcLength}
      stroke-dashoffset={dashOffset}
      style="transition: stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1);"
    />

    <!-- Dot glow (halo) -->
    <circle
      cx={dot.x}
      cy={dot.y}
      r={strokeWidth * 0.9}
      fill={color}
      opacity="0.55"
      filter="url(#{filterId})"
      style="transition: cx 0.6s cubic-bezier(0.4, 0, 0.2, 1), cy 0.6s cubic-bezier(0.4, 0, 0.2, 1);"
    />

    <!-- Dot bright -->
    <circle
      cx={dot.x}
      cy={dot.y}
      r={strokeWidth * 0.5}
      fill={color}
      style="transition: cx 0.6s cubic-bezier(0.4, 0, 0.2, 1), cy 0.6s cubic-bezier(0.4, 0, 0.2, 1);"
    />
  </svg>

  {#if showValue}
    <div class="absolute inset-0 flex items-center justify-center">
      <span class="text-2xl font-light text-white tabular-nums">
        {Math.round(clamped)}<span class="text-sm text-[var(--text-secondary)]">{valueSuffix}</span>
      </span>
    </div>
  {/if}
</div>
