/**
 * Catalogue des VRAIES couleurs de palettes du module WLED.
 *
 * L'aperçu peignait jusqu'ici une table de 18 dégradés écrits à la main, pour
 * un module qui en expose 72 : au-delà de cette liste, toute palette retombait
 * sur la couleur unique du segment — un « Aurora » ou un « Rivendell » se
 * peignait donc en aplat. WLED publie les couleurs exactes sur `/json/palx`,
 * c'est la seule source de vérité ; on la lit ici.
 *
 * Deux natures d'entrées, et la seconde est la raison d'être de ce module :
 *   - un dégradé FIXE  → suite de `[pos, r, g, b]`, `pos` sur 0–255 ;
 *   - un dégradé DYNAMIQUE → marqueurs `c1`/`c2`/`c3` (les 3 couleurs du
 *     segment) et `r` (aléatoire). « Color 1 », « Colors 1&2 » ou « Color
 *     Gradient » n'ont pas de couleur propre : elles empruntent celles du
 *     segment, et changent donc avec lui. C'est résolu à l'affichage
 *     (`preview-model`), pas ici — ce module reste une photo du firmware.
 *
 * Le résultat ne bouge qu'à un flashage de firmware : on le garde en cache
 * (TTL long) pour ne pas infliger 9 requêtes au module à chaque ouverture de
 * la page Pièces. Le module est sur le Wi-Fi de la terrasse à -73 dBm : chaque
 * aller-retour épargné compte.
 */

// Types définis dans `preview-model` (module partagé, pur TS) : c'est lui qui
// PEINT ces données, il en porte donc le vocabulaire. Les redéfinir ici ferait
// deux vérités pour une seule forme.
export type { PaletteStop, PaletteRef, PaletteEntry, PaletteMap } from '$lib/wled/preview-model';
import type { PaletteStop, PaletteRef, PaletteEntry, PaletteMap } from '$lib/wled/preview-model';

const TIMEOUT_MS = 8_000;
/** Les palettes sont figées dans le firmware — on relit une fois par jour. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Garde-fou : `m` vient du module, on ne le suit pas aveuglément. */
const MAX_PAGES = 24;

let cache: { key: string; data: PaletteMap; at: number } | null = null;

function isStop(v: unknown): v is PaletteStop {
  return (
    Array.isArray(v) && v.length >= 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isRef(v: unknown): v is PaletteRef {
  return v === 'c1' || v === 'c2' || v === 'c3' || v === 'r';
}

/** Ne garde que ce qu'on sait peindre — un firmware plus récent peut inventer
 *  des formes qu'on ignore alors sans casser l'aperçu. */
function sanitize(raw: unknown): PaletteEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PaletteEntry[] = [];
  for (const v of raw) {
    if (isStop(v)) out.push([v[0] & 255, v[1] & 255, v[2] & 255, v[3] & 255]);
    else if (isRef(v)) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * Lit toutes les pages de `/json/palx` et les fusionne.
 *
 * Une page qui échoue ne perd que ses palettes : on rend ce qu'on a pu lire
 * plutôt que rien — l'aperçu retombe sur son repli pour les manquantes.
 */
export async function fetchPalettes(base: string): Promise<PaletteMap> {
  const now = Date.now();
  if (cache && cache.key === base && now - cache.at < TTL_MS) return cache.data;

  const out: PaletteMap = {};
  let pages = 1;
  for (let page = 0; page < Math.min(pages, MAX_PAGES); page++) {
    let payload: { m?: unknown; p?: unknown } | null = null;
    try {
      const res = await fetch(`${base}/json/palx?page=${page}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) break;
      payload = (await res.json()) as { m?: unknown; p?: unknown };
    } catch {
      break;
    }
    if (page === 0 && typeof payload?.m === 'number' && payload.m > 0) pages = payload.m;
    const p = payload?.p;
    if (!p || typeof p !== 'object') continue;
    for (const [idx, raw] of Object.entries(p as Record<string, unknown>)) {
      const n = Number(idx);
      if (!Number.isInteger(n) || n < 0) continue;
      const entries = sanitize(raw);
      if (entries) out[n] = entries;
    }
  }

  if (!Object.keys(out).length) throw new Error('palettes illisibles');
  cache = { key: base, data: out, at: now };
  return out;
}

/** Vide le cache (utile si le module est reflashé sans redémarrer Domo). */
export function clearPaletteCache(): void {
  cache = null;
}
