/**
 * Helpers de tracé — courbes lissées (spline cubique « monotone », comme
 * Recharts `type="monotone"` / Yeldra) via d3-shape. Réutilisable pour tous les
 * graphes aire/ligne du dashboard.
 *
 * Les points sont en coordonnées SVG (déjà projetées dans le viewBox).
 */
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape';

export interface XY {
  x: number;
  y: number;
}

/** Chemin de ligne lissée. '' si moins de 2 points. */
export function smoothLinePath(points: XY[]): string {
  if (points.length < 2) return '';
  return (
    d3line<XY>()
      .x((p) => p.x)
      .y((p) => p.y)
      .curve(curveMonotoneX)(points) ?? ''
  );
}

/** Chemin d'aire lissée (même courbe), refermée sur la ligne de base `baseY`. */
export function smoothAreaPath(points: XY[], baseY: number): string {
  if (points.length < 2) return '';
  return (
    d3area<XY>()
      .x((p) => p.x)
      .y0(baseY)
      .y1((p) => p.y)
      .curve(curveMonotoneX)(points) ?? ''
  );
}

/**
 * Moyenne glissante centrée (lissage). `half` = nombre d'échantillons de part et
 * d'autre (fenêtre totale = 2·half+1) ; bords gérés (fenêtre rétrécie). half ≤ 0
 * → série inchangée. Préserve ~l'intégrale (donc l'énergie cumulée).
 */
export function smoothSeries(values: number[], half: number): number[] {
  if (half <= 0) return values;
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += values[j];
      cnt++;
    }
    out[i] = cnt ? sum / cnt : values[i];
  }
  return out;
}

/**
 * Index du point le plus proche d'une fraction horizontale [0..1] (hit-testing
 * du survol). `width` = largeur du viewBox dans laquelle les x sont exprimés.
 */
export function nearestIndex(points: XY[], fraction: number, width: number): number {
  const target = fraction * width;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].x - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
