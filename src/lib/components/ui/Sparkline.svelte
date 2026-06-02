<script lang="ts">
  interface Props {
    data: number[];
    /** Couleur stroke + area fill. */
    color?: string;
    /** Hauteur SVG (px). Largeur = 100% du parent. */
    height?: number;
    strokeWidth?: number;
    /** Opacité du fill sous la courbe. */
    fillOpacity?: number;
  }

  let {
    data,
    color = 'var(--color-primary)',
    height = 24,
    strokeWidth = 1.5,
    fillOpacity = 0.08
  }: Props = $props();

  const path = $derived.by(() => {
    if (data.length === 0) return { line: '', area: '' };
    const max = Math.max(...data, 0.0001);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const w = data.length - 1 || 1;
    const points = data.map((v, i) => {
      const x = (i / w) * 100;
      const y = height - ((v - min) / range) * height;
      return [x, y] as const;
    });
    const line = points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' ');
    const area = `${line} L100,${height} L0,${height} Z`;
    return { line, area };
  });
</script>

<svg
  viewBox="0 0 100 {height}"
  preserveAspectRatio="none"
  class="w-full"
  style="height: {height}px;"
  aria-hidden="true"
>
  <path d={path.area} fill={color} opacity={fillOpacity} />
  <path
    d={path.line}
    fill="none"
    stroke={color}
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    opacity="0.85"
    vector-effect="non-scaling-stroke"
  />
</svg>
