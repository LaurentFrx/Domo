/**
 * Styles du mode Musique — module PARTAGÉ client/serveur (pur TS, sans runes).
 * Le client s'en sert pour l'UI (chips) ; le serveur pour appliquer le rendu
 * au ruban (music-mode.ts). Une seule source de vérité.
 *
 * CONTRAT COULEURS (décision Laurent, 16/07) : les effets musicaux ont LEURS
 * PROPRES COULEURS — des palettes WLED multicolores dédiées par style. Jamais
 * de rendu monochrome, jamais les couleurs de pochette, jamais la couleur
 * posée par l'utilisateur (elle est restaurée à la sortie du mode).
 */

export type RGB = [number, number, number];

export interface WledMusicStyle {
  key: string;
  label: string;
  /** Nature de la réactivité (groupes de la grille) : l'utilisateur doit savoir
   *  qu'un effet ♪ ne suivra QUE le volume — c'est sa conception WLED. */
  kind: 'ambiance' | 'freq' | 'vol';
  /** Effet WLED (ordre de préférence). null = fondu « ambiance » (pas de stream). */
  fx: string[] | null;
  /** Palette MULTICOLORE du style (ordre de préférence — noms selon firmware). */
  pal: string[];
  /** Vitesse / intensité de l'effet (chaque effet audio a son point d'équilibre). */
  sx?: number;
  ix?: number;
  /** Description une ligne (title/aria uniquement — jamais affichée en dur). */
  hint: string;
}

// TOUS les effets audio-réactifs 1D du firmware 16.0.1 (décision Laurent :
// « mets-les tous, je trierai plus tard »). Écartés : GEQ / PS GEQ 2D /
// PS GEQ Nova, conçus pour des MATRICES — illisibles sur un ruban d'une ligne.
// Le hint contient le NOM NATIF WLED (repère pour le tri). Le fond (col[1])
// est géré par le rendu serveur : NOIR pendant les styles réactifs, sinon le
// fond plein masque la barre (courbe volume→lumière plate, mesuré).
export const WLED_MUSIC_STYLES: WledMusicStyle[] = [
  {
    kind: 'ambiance',
    key: 'ambiance',
    label: 'Ambiance',
    fx: null,
    pal: ['Sunset', 'Sunset 2', 'Party'],
    hint: 'Fondu doux multicolore, sans réactivité'
  },
  {
    kind: 'freq',
    key: 'vu3',
    label: 'VU aigus',
    fx: ['Gravfreq'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 128,
    hint: 'Gravfreq — niveau teinté par la fréquence'
  },
  {
    kind: 'freq',
    key: 'cascade',
    label: 'Cascade',
    fx: ['Waterfall'],
    pal: ['Atlantica', 'Ocean', 'Party'],
    sx: 130,
    ix: 128,
    hint: 'Waterfall — chute continue qui suit le son'
  },
  {
    kind: 'freq',
    key: 'cascade2',
    label: 'Cascade 2',
    fx: ['PS Waterfall'],
    pal: ['Atlantica', 'Ocean', 'Party'],
    sx: 130,
    ix: 128,
    hint: 'PS Waterfall — cascade à particules'
  },
  {
    kind: 'freq',
    key: 'feu',
    label: 'Feu',
    fx: ['Noisefire'],
    pal: ['Fire', 'Lava', 'Party'],
    sx: 128,
    ix: 140,
    hint: 'Noisefire — flammes qui suivent le son'
  },
  {
    kind: 'freq',
    key: 'lueurs',
    label: 'Lueurs',
    fx: ['Blurz'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Blurz — halos flous sur les notes'
  },
  {
    kind: 'freq',
    key: 'frequences',
    label: 'Fréquences',
    fx: ['Freqwave'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Freqwave — vagues colorées par la note'
  },
  {
    kind: 'freq',
    key: 'matrice',
    label: 'Matrice',
    fx: ['Freqmatrix'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Freqmatrix — défilement coloré par la note'
  },
  {
    kind: 'freq',
    key: 'pixels',
    label: 'Pixels',
    fx: ['Freqpixels'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Freqpixels — pixels colorés par la note'
  },
  {
    kind: 'freq',
    key: 'spectre',
    label: 'Spectre',
    fx: ['Freqmap'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Freqmap — la note se place sur le ruban'
  },
  {
    kind: 'freq',
    key: 'octaves',
    label: 'Octaves',
    fx: ['Rocktaves'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Rocktaves — une couleur par octave'
  },
  {
    kind: 'freq',
    key: 'egaliseur',
    label: 'Égaliseur',
    fx: ['PS GEQ 1D'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'PS GEQ 1D — bandes de fréquences'
  },
  {
    kind: 'freq',
    key: 'dj',
    label: 'DJ',
    fx: ['DJ Light'],
    pal: ['Party'],
    sx: 140,
    ix: 160,
    hint: 'DJ Light — flashs énergiques au rythme'
  },
  {
    kind: 'vol',
    key: 'vu',
    label: 'VU-mètre',
    fx: ['Gravcenter'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 128,
    hint: 'Gravcenter — niveau depuis le centre'
  },
  {
    kind: 'vol',
    key: 'vu2',
    label: 'VU classique',
    fx: ['Gravimeter'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 128,
    hint: 'Gravimeter — niveau depuis le bord'
  },
  {
    kind: 'vol',
    key: 'jauge',
    label: 'Jauge',
    fx: ['Noisemeter'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 128,
    hint: 'Noisemeter — jauge nerveuse du volume'
  },
  {
    kind: 'vol',
    key: 'vagues',
    label: 'Vagues',
    fx: ['Pixelwave'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Pixelwave — impulsions depuis le centre'
  },
  {
    kind: 'vol',
    key: 'defile',
    label: 'Défilé',
    fx: ['Matripix'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Matripix — pixels qui défilent au rythme'
  },
  {
    kind: 'vol',
    key: 'jongleur',
    label: 'Jongleur',
    fx: ['Juggles'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 140,
    hint: 'Juggles — boules lancées au rythme'
  },
  {
    kind: 'vol',
    key: 'gouttes',
    label: 'Gouttes',
    fx: ['Puddlepeak'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 200,
    hint: 'Puddlepeak — éclats sur les temps forts'
  },
  {
    kind: 'vol',
    key: 'flaques',
    label: 'Flaques',
    fx: ['Puddles'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 180,
    hint: 'Puddles — flaques de lumière au volume'
  },
  {
    kind: 'vol',
    key: 'ondes',
    label: 'Ondes',
    fx: ['Ripple Peak'],
    pal: ['Party', 'Rainbow'],
    sx: 128,
    ix: 180,
    hint: 'Ripple Peak — ondulations sur les pics'
  },
  {
    kind: 'vol',
    key: 'plasma',
    label: 'Plasma',
    fx: ['Plasmoid'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Plasmoid — nappes fluides au volume'
  },
  {
    kind: 'vol',
    key: 'nuee',
    label: 'Nuée',
    fx: ['Midnoise'],
    pal: ['Party', 'Rainbow'],
    sx: 110,
    ix: 140,
    hint: 'Midnoise — texture bruitée au médium'
  }
];

export function musicStyleDef(key: string): WledMusicStyle {
  return WLED_MUSIC_STYLES.find((s) => s.key === key) ?? WLED_MUSIC_STYLES[0];
}

/** Effets doux multi-couleurs du rendu « ambiance » ET de la pause, par ordre
 *  de préférence (la pause reste MULTICOLORE : fondu lent, jamais de Solid). */
export const MUSIC_FX = ['Blends', 'Colorwaves', 'Gradient', 'Breathe'];

/** Premier nom présent dans le catalogue du module (les noms varient selon la
 *  version WLED — un nom introuvable ne doit JAMAIS faire échouer en silence). */
export function resolveByName(catalog: string[], names: string | string[] | undefined): number {
  if (!names) return -1;
  for (const n of Array.isArray(names) ? names : [names]) {
    const i = catalog.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}
