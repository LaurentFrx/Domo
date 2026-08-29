/**
 * Action Svelte : peint un `<canvas>` avec les VRAIES couleurs des LED, une
 * par une, depuis le flux temps réel du firmware (`wledLeds`).
 *
 * Un pixel de canvas = une LED, le canvas est ensuite étiré en
 * `image-rendering: pixelated` : chaque LED reste un rectangle net, jamais un
 * dégradé interpolé. La trame n'étant pas réactive (≈12 images/s
 * re-rendraient tout l'écran), une boucle rAF la lit et ne repeint que
 * lorsqu'elle a changé.
 *
 * Partagée par la feuille (un canvas par ruban, découpé par segment) et la
 * tuile de /pieces (le ruban entier, les deux lignes bout à bout).
 */
import { wledLeds } from '$stores/wledLeds.svelte';

export interface LedSlice {
  /** Première LED physique à peindre. */
  start: number;
  /** Nombre de LED. */
  len: number;
}

export function ledStrip(canvas: HTMLCanvasElement, slice: LedSlice) {
  let raf = 0;
  let paintedAt = -1;
  const ctx = canvas.getContext('2d', { alpha: false });

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!ctx || !wledLeds.frame || wledLeds.frameAt === paintedAt) return;
    paintedAt = wledLeds.frameAt;
    const n = Math.max(1, slice.len);
    if (canvas.width !== n) canvas.width = n;
    if (canvas.height !== 1) canvas.height = 1;
    const img = ctx.createImageData(n, 1);
    for (let i = 0; i < n; i++) {
      const c = wledLeds.led(slice.start + i);
      const o = i * 4;
      img.data[o] = c ? c[0] : 0;
      img.data[o + 1] = c ? c[1] : 0;
      img.data[o + 2] = c ? c[2] : 0;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };

  raf = requestAnimationFrame(tick);
  return {
    update(next: LedSlice) {
      slice = next;
      paintedAt = -1; // la découpe a changé : repeindre sans attendre la trame suivante
    },
    destroy() {
      cancelAnimationFrame(raf);
    }
  };
}
