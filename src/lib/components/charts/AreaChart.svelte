<script lang="ts">
  interface Props {
    data: number[];
    color?: string;
    height?: number;
  }

  let { data, color = 'var(--accent-500)', height = 80 }: Props = $props();

  const width = 300;
  const padX = 4;
  const padY = 6;

  const points = $derived.by(() => {
    if (!data.length) return [] as { x: number; y: number }[];
    const max = Math.max(...data, 0.0001);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const n = data.length;
    return data.map((v, i) => {
      const x = padX + (i * (width - padX * 2)) / Math.max(1, n - 1);
      const norm = (v - min) / range;
      const y = padY + (1 - norm) * (height - padY * 2);
      return { x, y };
    });
  });

  function buildSmoothPath(pts: { x: number; y: number }[], tension = 0.3): string {
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? pts[i + 1];
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  const strokePath = $derived(buildSmoothPath(points));
  const fillPath = $derived.by(() => {
    if (!points.length) return '';
    const last = points[points.length - 1];
    const first = points[0];
    return `${strokePath} L ${last.x} ${height} L ${first.x} ${height} Z`;
  });

  const gradId = `area-grad-${Math.random().toString(36).slice(2, 9)}`;
</script>

<svg
  viewBox="0 0 {width} {height}"
  preserveAspectRatio="none"
  class="area-chart w-full"
  style="height: {height}px;"
>
  <defs>
    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color={color} stop-opacity="0.35" />
      <stop offset="100%" stop-color={color} stop-opacity="0.02" />
    </linearGradient>
  </defs>

  <path d={fillPath} fill="url(#{gradId})" />
  <path
    d={strokePath}
    fill="none"
    stroke={color}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>

<style>
  @keyframes area-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .area-chart {
    animation: area-fade-in 0.7s ease-out;
  }
</style>
