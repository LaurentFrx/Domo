/**
 * Modèle d'APERÇU du ruban terrasse — module PARTAGÉ (pur TS, sans runes).
 *
 * Traduit un état WLED (nom d'effet + nom de palette) en ce qu'il faut pour le
 * PEINDRE et le NOMMER :
 *   - `gradientStops()` → les couleurs réelles quand l'effet/la palette est
 *     multicolore (arc-en-ciel, Party, Sunset…), sinon `null` = couleur du
 *     segment ;
 *   - `familyOf()` → la famille de mouvement (fixe / défilement / balayage /
 *     scintillement / pulsation) qui pilote l'animation de l'aperçu ;
 *   - `stateLabel()` → la légende FR d'un état (« Blanc 4000K », « Bougie »,
 *     « Musique · en pause », « Éteint »).
 *
 * Extrait de `WledPreview.svelte` : la barre héros de la feuille ET la tuile
 * de la page Pièces peignent le MÊME ruban — une seule source de vérité, sinon
 * les deux divergent au premier effet ajouté.
 */

export type RGB = [number, number, number];

/** Palettes « couleur » (= utilisent la couleur du segment, pas un dégradé). */
const COLOR_PALETTES = new Set([
  'Default',
  'Random Cycle',
  '* Random Cycle',
  'Color 1',
  '* Color 1',
  'Colors 1&2',
  '* Colors 1&2',
  'Color Gradient',
  '* Color Gradient',
  'Colors Only'
]);

const RAINBOW = ['#ff0040', '#ff8000', '#ffff00', '#00ff40', '#00ffff', '#0040ff', '#8000ff'];

const RAINBOW_FX = new Set([
  'Rainbow',
  'Rainbow Runner',
  'Colorful',
  'Colorloop',
  'Colorwaves',
  'Pride 2015',
  'Aurora',
  'Palette',
  'Blends',
  'Plasma',
  'Flow',
  'Noise Pal'
]);

/** Effets à mouvement spatial (un point/segment qui balaye). */
const SWEEP_FX = new Set([
  'Scan',
  'Scan Dual',
  'Scanner',
  'Scanner Dual',
  'Wipe',
  'Wipe Random',
  'Tri Wipe',
  'Sweep',
  'Sweep Random',
  'Running',
  'Running Dual',
  'Chase',
  'Chase Random',
  'Chase Rainbow',
  'Chase Flash',
  'Chase Flash Rnd',
  'Chase 2',
  'Chase 3',
  'Lighthouse',
  'Loading',
  'Meteor',
  'Meteor Smooth',
  'Multi Comet',
  'Drip',
  'Sinelon',
  'Sinelon Dual',
  'Sinelon Rainbow',
  'Two Dots',
  'Stream',
  'Stream 2',
  'Rolling Balls',
  'Bouncing Balls',
  'Popcorn',
  'ICU',
  'Railway',
  'Android',
  'Tetrix',
  'Percent'
]);

/** Effets « scintillants » (flamme, étincelles, strobe…). */
const FLICKER_FX = new Set([
  'Fire 2012',
  'Fire Flicker',
  'Candle',
  'Candle Multi',
  'Lightning',
  'Halloween Eyes',
  'Fireworks',
  'Fireworks Starburst',
  'Fireworks 1D',
  'Sparkle',
  'Sparkle Dark',
  'Sparkle+',
  'Glitter',
  'Solid Glitter',
  'Strobe',
  'Strobe Rainbow',
  'Strobe Mega',
  'Blink',
  'Blink Rainbow',
  'Twinkle',
  'Twinklefox',
  'Twinklecat',
  'Twinkleup',
  'Fairytwinkle',
  'Fairy',
  'Colortwinkles',
  'Dissolve',
  'Dissolve Rnd',
  'Random Colors'
]);

/**
 * Dégradés écrits à la main — désormais REPLI seulement.
 *
 * La source de vérité est `/json/palx` (les 72 palettes du firmware, couleurs
 * exactes) : cette table ne sert plus que si le module n'a pas encore répondu,
 * ou pour les rares palettes qu'il ne publie pas.
 */
export const PALETTE_GRADIENTS: Record<string, string[]> = {
  Party: ['#ff00b0', '#ff0040', '#ffb000', '#ffe000', '#00d0ff', '#7000ff'],
  Rainbow: RAINBOW,
  'Rainbow Bands': RAINBOW,
  Sunset: ['#2b1a4a', '#7a2e6b', '#e0533f', '#ff9e4f', '#ffd66b'],
  'Sunset 2': ['#3a1d6e', '#c0395f', '#ff6a3c', '#ffb24f', '#ffe08a'],
  Ocean: ['#012a4a', '#0353a4', '#2c7da0', '#61a5c2', '#a9d6e5'],
  Atlantica: ['#003049', '#0077b6', '#00b4d8', '#90e0ef'],
  Forest: ['#0b3d0b', '#1e6b1e', '#3fa34d', '#9bd17a', '#d8f3a0'],
  Lava: ['#1a0000', '#5a0000', '#b30000', '#ff6a00', '#ffd000'],
  Fire: ['#1a0000', '#7a0000', '#ff3000', '#ff9a00', '#ffe000'],
  Cloud: ['#0a1a4a', '#2a52be', '#6fa8dc', '#bcd6f2', '#ffffff'],
  Pastel: ['#ffd1dc', '#ffe7c2', '#fff7c2', '#c2f0d8', '#cfe3ff', '#e6d1ff'],
  Beach: ['#1d6fa3', '#36a0c2', '#7fd1c4', '#f6e7b4', '#f2c14e'],
  'April Night': ['#001b2e', '#0a4d68', '#088395', '#05bfdb', '#a0f0ff'],
  Temperature: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'],
  C9: ['#ff0000', '#00b000', '#0040ff', '#ffb000', '#ffffff'],
  Yelblu: ['#ffe000', '#80c0ff', '#0040ff'],
  Magenta: ['#ff00ff', '#ff66ff', '#cc00cc'],
  'Orange & Teal': ['#ff7a00', '#ffd0a0', '#1fb6b6', '#0a6b6b']
};

/** Libellés FR des effets courants (sinon nom brut WLED). */
export const FX_FR: Record<string, string> = {
  Solid: 'Couleur fixe',
  Breathe: 'Respiration',
  Fade: 'Fondu',
  Candle: 'Bougie',
  'Candle Multi': 'Bougies',
  'Fire 2012': 'Feu',
  'Fire Flicker': 'Feu',
  Colorloop: 'Boucle de couleurs',
  Colorwaves: 'Vagues de couleur',
  Blends: 'Fondu de couleurs',
  Rainbow: 'Arc-en-ciel',
  'Rainbow Runner': 'Arc-en-ciel',
  Aurora: 'Aurore',
  Pacifica: 'Océan',
  Twinklefox: 'Scintillement',
  Twinkle: 'Scintillement',
  Scanner: 'Balayage',
  Scan: 'Balayage',
  Meteor: 'Comète',
  'Multi Comet': 'Comètes',
  Sparkle: 'Étincelles',
  Glitter: 'Paillettes',
  Blink: 'Clignotement',
  Strobe: 'Stroboscope',
  Plasma: 'Plasma',
  Lightning: 'Éclair',
  Heartbeat: 'Battement',
  Drip: 'Gouttes'
};

export type Family = 'solid' | 'scroll' | 'sweep' | 'flicker' | 'pulse';

/** Couleurs réelles quand l'effet/la palette est multicolore, sinon `null`. */
export function gradientStops(fxName: string, palName: string): string[] | null {
  const bare = palName.replace(/^\* /, '');
  if (!COLOR_PALETTES.has(palName) && PALETTE_GRADIENTS[bare]) return PALETTE_GRADIENTS[bare];
  if (RAINBOW_FX.has(fxName)) return RAINBOW;
  return null;
}

/** Famille de mouvement de l'effet (pilote l'animation de l'aperçu). */
export function familyOf(fxName: string, stops: readonly unknown[] | null): Family {
  if (fxName === 'Solid') return 'solid';
  if (stops) return 'scroll';
  if (SWEEP_FX.has(fxName)) return 'sweep';
  if (FLICKER_FX.has(fxName)) return 'flicker';
  return 'pulse';
}

/** État du mode Musique tel que l'aperçu a besoin de le lire (vue serveur). */
export interface MusicSnapshot {
  enabled: boolean;
  analyzing: boolean;
  trackKey: string | null;
  playing: boolean;
}

/**
 * Légende d'état d'une ligne.
 *
 * En mode Musique, l'état parlant est le SUIVI, pas l'effet interne (en pause
 * le module repasse en Solid → « Couleur fixe » serait trompeur).
 */
export function stateLabel(opts: {
  on: boolean;
  fxName: string;
  /** Le segment n'a QUE du blanc 4000K (teinte RGB nulle). */
  whiteOnly: boolean;
  music: MusicSnapshot;
}): string {
  const { on, fxName, whiteOnly, music } = opts;
  if (!on) return 'Éteint';
  if (music.enabled) {
    if (music.analyzing) return 'Musique · analyse du morceau…';
    if (!music.trackKey) return 'Musique · en attente de lecture';
    return music.playing ? 'Musique' : 'Musique · en pause';
  }
  if (whiteOnly && fxName === 'Solid') return 'Blanc 4000K';
  return FX_FR[fxName] ?? fxName;
}

/* ═══ Couleurs RÉELLES des palettes (source : /json/palx du module) ═══════ */

/** Un arrêt de dégradé : position 0–255 puis RVB (format WLED). */
export type PaletteStop = [number, number, number, number];
/** `c1`/`c2`/`c3` = couleurs du segment, `r` = aléatoire (WLED). */
export type PaletteRef = 'c1' | 'c2' | 'c3' | 'r';
export type PaletteEntry = PaletteStop | PaletteRef;
/** Palettes indexées par leur index WLED (= `seg.pal`). */
export type PaletteMap = Record<number, PaletteEntry[]>;

/** Arrêt prêt à peindre : couleur + position relative (0–1). */
export interface Stop {
  rgb: RGB;
  pos: number;
}

function isBlack([r, g, b]: RGB): boolean {
  return r === 0 && g === 0 && b === 0;
}

/**
 * Traduit une palette du firmware en arrêts peignables.
 *
 * Les palettes « dynamiques » (`c1`/`c2`/`c3`) n'ont pas de couleur propre :
 * elles reprennent celles du segment. On leur passe la couleur EFFECTIVE de la
 * ligne (teinte + canal blanc), jamais la teinte brute — le ruban terrasse est
 * le plus souvent en blanc 4000K pur, c'est-à-dire `col = [0,0,0]` avec tout le
 * signal sur le canal W : peindre la teinte brute donnerait un ruban NOIR.
 *
 * `r` (aléatoire) change en permanence sur le module ; un aperçu qui clignote à
 * chaque rendu serait pire qu'inexact, on le représente par l'arc-en-ciel.
 *
 * @returns `null` quand la palette ne donne rien de peignable — l'appelant
 *   retombe alors sur l'aplat teinté, comme avant.
 */
export function resolvePalette(
  def: PaletteEntry[] | undefined,
  colors: { c1: RGB; c2: RGB; c3: RGB }
): Stop[] | null {
  if (!def?.length) return null;

  const fixed = def.filter((e): e is PaletteStop => Array.isArray(e));
  // Le firmware ne mélange pas les deux natures : soit des arrêts positionnés,
  // soit des références. On traite le cas majoritaire et on ignore le reste.
  if (fixed.length) {
    const stops = fixed
      .map<Stop>(([pos, r, g, b]) => ({ rgb: [r, g, b], pos: Math.min(1, Math.max(0, pos / 255)) }))
      .sort((a, b) => a.pos - b.pos);
    return usable(stops);
  }

  const refs = def.filter((e): e is PaletteRef => typeof e === 'string');
  if (!refs.length) return null;
  // Palette entièrement aléatoire : l'arc-en-ciel est la représentation stable
  // la plus honnête de « toutes les couleurs y passent ».
  if (refs.every((r) => r === 'r')) return hexesToStops(RAINBOW);

  const pick = (ref: PaletteRef): RGB =>
    ref === 'c2' ? colors.c2 : ref === 'c3' ? colors.c3 : colors.c1;
  const last = Math.max(1, refs.length - 1);
  const stops = refs.map<Stop>((ref, i) => ({
    rgb: ref === 'r' ? colors.c1 : pick(ref),
    pos: i / last
  }));
  return usable(stops);
}

/**
 * Écarte ce qu'on ne saurait pas peindre.
 *
 *  - MOINS DE DEUX arrêts : `linear-gradient` en exige deux. « Color 1 » n'en
 *    donne qu'un — le peindre produirait un dégradé invalide, donc un fond
 *    transparent. Un seul arrêt veut de toute façon dire « aplat de la couleur
 *    de la ligne », ce que l'appelant sait déjà faire, en mieux (teinte
 *    remontée à pleine luminance).
 *  - TOUT NOIR : les couleurs 2 et 3 restent souvent à zéro sur un ruban réglé
 *    en blanc ; une palette qui n'y référerait que du noir éteindrait l'aperçu
 *    d'un ruban pourtant allumé.
 */
function usable(stops: Stop[]): Stop[] | null {
  if (stops.length < 2) return null;
  return stops.every((s) => isBlack(s.rgb)) ? null : stops;
}

/**
 * CE QU'IL FAUT PEINDRE pour une ligne : les vraies couleurs, ou `null` pour
 * un aplat de la couleur de la ligne.
 *
 * L'arbitrage compte autant que les couleurs, parce qu'une palette n'est pas
 * toujours appliquée :
 *   - `Solid` SORT LA COULEUR 1 et ignore la palette — peindre le dégradé de
 *     la palette montrerait un ruban qui n'existe pas ;
 *   - la palette « Default » (index 0) veut dire « les couleurs propres de
 *     l'effet », qu'on ne peut pas deviner : on garde l'aplat, sauf pour les
 *     effets dont on sait qu'ils balaient le spectre.
 * Hors de ces deux cas, les couleurs du firmware font foi ; la table écrite à
 * la main ne sert plus que si le module ne les a pas (encore) données.
 */
export function paintStops(opts: {
  fxName: string;
  palName: string;
  palIndex: number;
  palettes: PaletteMap;
  c1: RGB;
  c2: RGB;
  c3: RGB;
}): Stop[] | null {
  const { fxName, palName, palIndex, palettes } = opts;
  if (fxName === 'Solid') return null;

  const bare = palName.replace(/^\* /, '');
  if (palIndex === 0 || bare === 'Default') {
    return RAINBOW_FX.has(fxName) ? hexesToStops(RAINBOW) : null;
  }

  const real = resolvePalette(palettes[palIndex], opts);
  if (real) return real;
  const legacy = gradientStops(fxName, palName);
  return legacy ? hexesToStops(legacy) : null;
}

/** Convertit la table de repli (hex) en arrêts régulièrement espacés. */
export function hexesToStops(hexes: string[]): Stop[] {
  const last = Math.max(1, hexes.length - 1);
  return hexes.map((h, i) => ({ rgb: hexToRgb(h), pos: i / last }));
}

/**
 * Prépare un dégradé à DÉFILER en boucle : rejoue le premier arrêt à la fin,
 * en COMPRIMANT d'abord les positions pour lui faire une vraie place.
 *
 * Les arrêts finissent toujours à pos 1 (hexesToStops comme les palettes du
 * firmware) : ajouter naïvement le rebouclage à pos 1 crée un arrêt COÏNCIDENT
 * avec le dernier — rampe de fermeture de largeur nulle, donc un saut dur
 * dernière→première couleur à chaque jonction d'image (`repeat-x` sur 200 %).
 * Compression ×(N−1)/N : sur des arrêts uniformes, on retrouve exactement la
 * répartition uniforme à N+1 couleurs — la boucle est sans couture.
 */
export function wrapStops(stops: Stop[]): Stop[] {
  const n = stops.length;
  if (n < 2) return stops;
  const scale = (n - 1) / n;
  return [...stops.map((s) => ({ ...s, pos: s.pos * scale })), { rgb: stops[0].rgb, pos: 1 }];
}

/** Arrêts prêts pour un `linear-gradient` CSS. */
export function stopsToCss(stops: Stop[]): string {
  return stops
    .map((s) => `rgb(${s.rgb[0]} ${s.rgb[1]} ${s.rgb[2]}) ${(s.pos * 100).toFixed(1)}%`)
    .join(', ');
}

/** Couleur moyenne d'une série d'arrêts — sert aux lueurs (une lueur = UNE couleur). */
export function averageOfStops(stops: Stop[]): RGB {
  if (!stops.length) return [0, 0, 0];
  const sum = stops.reduce<[number, number, number]>(
    (acc, s) => [acc[0] + s.rgb[0], acc[1] + s.rgb[1], acc[2] + s.rgb[2]],
    [0, 0, 0]
  );
  return [
    Math.round(sum[0] / stops.length),
    Math.round(sum[1] / stops.length),
    Math.round(sum[2] / stops.length)
  ];
}

/** `#rrggbb` → RGB (repli noir si la chaîne n'est pas un hex à 6 chiffres). */
export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * TEINTE d'une couleur perçue, ramenée à pleine luminance et saturée.
 *
 * `previewColor()` mélange la teinte au canal blanc ATTÉNUÉ : parfait pour une
 * barre posée sur fond neutre (le niveau se lit dans la couleur), désastreux
 * pour teinter une surface — un blanc 4000K à mi-course y donne `rgb(132 115 99)`,
 * soit un brun sale. Ici on garde la seule information utile — la teinte — en
 * la remontant à pleine luminance, puis on l'éloigne du gris pour qu'un blanc
 * chaud reste une COULEUR et pas un voile. Le NIVEAU, lui, est porté ailleurs
 * (largeur du remplissage + intensité de la lueur).
 */
export function vividTint(rgb: RGB): RGB {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  if (mx === 0) return [...WARM_FALLBACK];
  const boost = 1.9; // écart au gris ×1.9 → un blanc chaud devient un ambre net
  return rgb.map((c) => {
    const full = (c / mx) * 255;
    return Math.max(0, Math.min(255, Math.round(255 - (255 - full) * boost)));
  }) as RGB;
}

/** Teinte de repli quand il n'y a aucune couleur à normaliser (ruban à zéro). */
const WARM_FALLBACK: RGB = [255, 223, 191];
