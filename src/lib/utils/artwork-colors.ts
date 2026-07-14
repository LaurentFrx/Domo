/**
 * Extraction des couleurs dominantes d'une pochette d'album (suivi musique de
 * l'éclairage terrasse). Tout se passe côté client : l'image passe par le proxy
 * /api/plex/image (même origine) → canvas lisible sans souci de CORS.
 *
 * Méthode : sous-échantillonnage 24×24, histogramme par teinte (12 buckets),
 * pondéré par saturation × luminance (les pixels quasi gris/noirs/blancs ne
 * votent pas). Les couleurs rendues sont re-saturées : un ruban LED éclaire mal
 * avec des tons délavés — on veut « l'esprit » de la pochette, pas sa mesure.
 */

import type { RGB } from '$stores/wled.svelte';

const SAMPLE = 24;
const HUE_BUCKETS = 12;
/** En-dessous, la pochette est considérée monochrome (N&B, sépia…). */
const MIN_CHROMA_VOTES = 8;
/** Palette de repli pour les pochettes sans couleur exploitable : blanc chaud. */
const FALLBACK: RGB[] = [
  [255, 170, 70],
  [255, 120, 60],
  [255, 210, 140]
];

function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

interface Bucket {
  weight: number;
  h: number; // somme pondérée (moyenne circulaire approx. par bucket étroit)
  s: number;
  v: number;
  votes: number;
}

/**
 * Couleurs dominantes de l'image, ordonnées par poids. Résout toujours
 * (repli blanc chaud si l'image ne charge pas ou est monochrome).
 */
export async function extractArtworkColors(url: string, count = 3): Promise<RGB[]> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return FALLBACK.slice(0, count);
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

    const buckets: Bucket[] = Array.from({ length: HUE_BUCKETS }, () => ({
      weight: 0,
      h: 0,
      s: 0,
      v: 0,
      votes: 0
    }));

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (max < 0.12 || d < 0.09) continue; // trop sombre ou trop gris : ne vote pas
      let h = 0;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const s = d / max;
      const w = s * max; // saturation × luminance
      const k = Math.floor(h / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
      const bk = buckets[k];
      bk.weight += w;
      bk.h += h * w;
      bk.s += s * w;
      bk.v += max * w;
      bk.votes++;
    }

    const ranked = buckets
      .filter((b) => b.votes >= MIN_CHROMA_VOTES && b.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, count);
    if (!ranked.length) return FALLBACK.slice(0, count);

    const out = ranked.map((b) => {
      const h = b.h / b.weight;
      // Re-saturation : plancher 0.65, pleine luminosité (le bri du module dose).
      const s = Math.max(0.65, Math.min(1, b.s / b.weight));
      return hsvToRgb(h, s, 1);
    });
    // Complète à `count` en réutilisant la dominante (WLED veut ses 3 slots).
    while (out.length < count) out.push(out[out.length % ranked.length]);
    return out;
  } catch {
    return FALLBACK.slice(0, count);
  }
}
