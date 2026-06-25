// AUTO-GÉNÉRÉ depuis « Plan Maison.sh3d » (Sweet Home 3D → Home.xml).
// Géométrie en MÈTRES, plan XZ (Y = haut), centrée sur l'origine.
// Régénérer : ~/maison-sh3d/parse_plan.py puis emit_ts.py. Ne pas éditer les
// coordonnées à la main ; les noms de pièces (provisoires) sont libres à ajuster.

export type Wall = { x1: number; z1: number; x2: number; z2: number; h: number; t: number };
export type Room = {
  id: string;
  name: string;
  accent: string;
  area: number;
  floor: string | null;
  labelAt: [number, number];
  /** Léger rehaussement du sol (m) pour les pièces qui en chevauchent une autre. */
  lift: number;
  /** Une pièce logique peut regrouper plusieurs polygones (ex. terrasse). */
  polygons: [number, number][][];
};
export type Opening = {
  name: string | null;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  elev: number;
  angle: number;
};
export type FurnitureCat = 'seat' | 'storage' | 'appliance' | 'table' | 'screen' | 'other';
export type Furniture = {
  name: string | null;
  cat: FurnitureCat;
  /** centre (m, monde) */
  x: number;
  z: number;
  /** dimensions (m) */
  w: number;
  d: number;
  h: number;
  /** hauteur de la base au-dessus du sol (m) */
  elev: number;
  /** rotation autour de la verticale (rad, convention SH3D) */
  angle: number;
};

export const WALL_HEIGHT = 2.5;
export const FOOTPRINT: [number, number] = [11.041, 11.4481];

export const WALLS: Wall[] = [
  { x1: 5.5205, z1: -5.7241, x2: 5.5205, z2: -2.3065, h: 2.48, t: 0.25 },
  { x1: 5.5205, z1: -2.3065, x2: 3.3405, z2: -2.3065, h: 2.48, t: 0.25 },
  { x1: 3.3405, z1: -2.3065, x2: 3.3405, z2: 2.2891, h: 2.48, t: 0.25 },
  { x1: 3.3405, z1: 2.2891, x2: -5.5205, z2: 2.2891, h: 2.48, t: 0.25 },
  { x1: -5.5205, z1: 2.2891, x2: -5.5205, z2: -5.7165, h: 2.48, t: 0.25 },
  { x1: 3.2161, z1: -2.3049, x2: -0.5139, z2: -2.3049, h: 2.48, t: 0.25 },
  { x1: -0.5139, z1: -2.3049, x2: -0.5139, z2: -5.5919, h: 2.48, t: 0.25 },
  { x1: 1.3594, z1: -5.5919, x2: 1.3594, z2: -2.4219, h: 2.48, t: 0.075 },
  { x1: -0.0717, z1: 2.2891, x2: -0.0717, z2: 1.0392, h: 2.48, t: 0.075 },
  { x1: -0.0717, z1: 1.0392, x2: 0.6483, z2: 1.0392, h: 2.48, t: 0.075 },
  { x1: 0.6483, z1: 1.0392, x2: 0.6483, z2: -0.5258, h: 2.48, t: 0.075 },
  { x1: 3.3405, z1: -0.2203, x2: 2.5072, z2: -0.2203, h: 2.48, t: 0.075 },
  { x1: 2.5072, z1: -0.2203, x2: 2.5072, z2: -0.8558, h: 2.48, t: 0.075 },
  { x1: 2.5072, z1: -0.8558, x2: 1.6638, z2: -0.8558, h: 2.48, t: 0.015 },
  { x1: 1.6638, z1: -0.8558, x2: 1.6638, z2: -0.2203, h: 2.48, t: 0.075 },
  { x1: -1.0271, z1: 1.0015, x2: -1.0271, z2: -0.8558, h: 2.48, t: 0.075 },
  { x1: 0.6483, z1: -0.484, x2: -0.9917, z2: -0.484, h: 2.48, t: 0.075 },
  { x1: -2.0081, z1: -0.8558, x2: -2.0081, z2: 2.1639, h: 2.48, t: 0.075 },
  { x1: -5.5205, z1: -5.7165, x2: 1.3594, z2: -5.7241, h: 2.48, t: 0.25 },
  { x1: 1.3594, z1: -5.7241, x2: 5.5205, z2: -5.7241, h: 2.48, t: 0.25 },
  { x1: 0.9408, z1: 2.4241, x2: 0.9408, z2: 4.8741, h: 2.2, t: 0.075 },
  { x1: 0.9408, z1: 4.8741, x2: 2.8908, z2: 4.8741, h: 2.2, t: 0.075 },
  { x1: 2.8908, z1: 4.8741, x2: 2.8908, z2: 2.4241, h: 1.7, t: 0.075 },
  { x1: 2.8908, z1: 2.4241, x2: 0.9408, z2: 2.4241, h: 1.7, t: 0.075 },
  { x1: 0.9408, z1: 2.4241, x2: 0.9408, z2: 5.7241, h: 2.2, t: 0.075 },
  { x1: 0.9408, z1: 5.7241, x2: -2.4092, z2: 5.7241, h: 2.2, t: 0.075 }
];

export const ROOMS: Room[] = [
  {
    id: 'room-0',
    name: 'Terrasse',
    accent: '#FFB454',
    area: 65.734,
    floor: "Parquet à l'anglaise marron rouge",
    labelAt: [-5.6955, 1.1656],
    lift: 0,
    polygons: [
      [
        [-5.6455, -5.8413],
        [-11.4014, -5.8413],
        [-11.4014, -3.1087],
        [-9.4514, -3.1087],
        [-8.1786, -1.8359],
        [-8.1786, 2.4141],
        [-8.1786, 6.6141],
        [-2.2967, 6.6141],
        [-2.2967, 5.6866],
        [0.9033, 5.6866],
        [0.9214, 2.4141],
        [-5.6455, 2.4141]
      ]
    ]
  },
  {
    id: 'room-1',
    name: 'Vélos',
    accent: '#3DFD98',
    area: 5.0,
    floor: 'Béton',
    labelAt: [1.9214, 3.6641],
    lift: 0,
    polygons: [
      [
        [0.9214, 2.4141],
        [2.9214, 2.4141],
        [2.9214, 4.9141],
        [0.9214, 4.9141]
      ]
    ]
  },
  {
    id: 'room-x0',
    name: 'Salle à Manger',
    accent: '#FF6F61',
    area: 16.4981,
    floor: 'Carreaux gris',
    labelAt: [-3.0175, -3.9525],
    lift: 0.0,
    polygons: [
      [
        [-5.521, -5.6],
        [-0.514, -5.6],
        [-0.514, -2.305],
        [-5.521, -2.305]
      ]
    ]
  },
  {
    id: 'room-x1',
    name: 'Salon',
    accent: '#6E45FF',
    area: 17.8504,
    floor: 'Carreaux gris',
    labelAt: [-3.4609, -0.2554],
    lift: 0.0,
    polygons: [
      [
        [-0.514, -2.305],
        [-5.521, -2.305],
        [-5.521, 2.16],
        [-2.008, 2.16],
        [-2.008, -0.856],
        [-1.027, -0.856],
        [-0.514, -0.856]
      ]
    ]
  },
  {
    id: 'room-x2',
    name: 'Buanderie',
    accent: '#F25FB6',
    area: 6.1715,
    floor: 'Béton',
    labelAt: [0.4225, -3.9525],
    lift: 0.0,
    polygons: [
      [
        [-0.514, -5.6],
        [1.359, -5.6],
        [1.359, -2.305],
        [-0.514, -2.305]
      ]
    ]
  },
  {
    id: 'room-x3',
    name: 'Atelier',
    accent: '#45C8FF',
    area: 13.7096,
    floor: 'Béton',
    labelAt: [3.44, -3.953],
    lift: 0.0,
    polygons: [
      [
        [1.359, -5.6],
        [5.521, -5.6],
        [5.521, -2.306],
        [1.359, -2.306]
      ]
    ]
  },
  {
    id: 'room-x4',
    name: 'Entrée',
    accent: '#FF9A52',
    area: 7.1174,
    floor: 'Carreaux gris',
    labelAt: [1.3721, -1.3747],
    lift: 0.0,
    polygons: [
      [
        [3.341, -2.305],
        [-0.514, -2.305],
        [-0.514, -0.856],
        [-1.027, -0.856],
        [-1.027, -0.484],
        [1.664, -0.484],
        [1.664, -0.856],
        [2.507, -0.856],
        [2.507, -0.22],
        [3.341, -0.22],
        [3.341, -0.856]
      ]
    ]
  },
  {
    id: 'room-x5',
    name: 'Cuisine',
    accent: '#FFD23F',
    area: 8.0208,
    floor: 'Carreaux gris',
    labelAt: [1.8008, 0.8883],
    lift: 0.0,
    polygons: [
      [
        [1.664, -0.856],
        [1.664, -0.484],
        [0.648, -0.484],
        [0.648, 1.039],
        [-0.072, 1.039],
        [-0.072, 2.16],
        [3.341, 2.16],
        [3.341, -0.22],
        [2.507, -0.22],
        [2.507, -0.856]
      ]
    ]
  },
  {
    id: 'room-x6',
    name: 'Toilette',
    accent: '#2DD4BF',
    area: 6.5803,
    floor: 'Carreaux gris',
    labelAt: [-0.8452, 0.661],
    lift: 0.0,
    polygons: [
      [
        [0.648, 1.039],
        [0.648, -0.484],
        [-1.027, -0.484],
        [-1.027, -0.856],
        [-2.008, -0.856],
        [-2.008, 2.16],
        [-1.027, 2.16],
        [-0.072, 2.16],
        [-0.072, 1.039]
      ]
    ]
  }
];

export const OPENINGS: Opening[] = [
  {
    name: "Porte d'entrée",
    x: 3.3058,
    z: -1.6263,
    w: 0.9,
    d: 0.3195,
    h: 2.085,
    elev: 0.0,
    angle: 1.6
  },
  {
    name: 'Porte de garage',
    x: 5.5205,
    z: -4.0039,
    w: 2.5,
    d: 0.25,
    h: 2.213,
    elev: 0.0,
    angle: 4.7
  },
  { name: 'Porte', x: 0.0502, z: -2.3263, w: 0.83, d: 0.2, h: 2.1, elev: 0.0, angle: 3.1 },
  {
    name: 'Porte-fenêtre coulissante',
    x: -3.6827,
    z: 2.2891,
    w: 2.0,
    d: 0.25,
    h: 2.18,
    elev: 0.0,
    angle: 3.1
  },
  {
    name: 'Fenêtre double',
    x: 3.2961,
    z: 0.877,
    w: 1.23,
    d: 0.5,
    h: 0.927,
    elev: 1.06,
    angle: 1.6
  },
  {
    name: 'Porte-fenêtre coulissante',
    x: -5.5205,
    z: -4.0963,
    w: 1.88,
    d: 0.25,
    h: 2.18,
    elev: 0.0,
    angle: 4.7
  },
  { name: 'Porte', x: -0.5261, z: -0.473, w: 0.83, d: 0.175, h: 2.1, elev: 0.0, angle: 6.3 },
  { name: 'Porte', x: 2.0165, z: 4.8891, w: 1.1, d: 0.1, h: 1.7, elev: 0.0, angle: 0.0 }
];

export const FURNITURE: Furniture[] = [
  {
    name: 'Chauffeau électrique sur pied',
    cat: 'appliance',
    x: -1.372,
    z: 1.883,
    w: 0.55,
    d: 0.55,
    h: 1.5,
    elev: 0.0,
    angle: 3.1416
  },
  {
    name: 'Air conditionné intérieur',
    cat: 'appliance',
    x: -5.2965,
    z: -1.7761,
    w: 0.885,
    d: 0.198,
    h: 0.285,
    elev: 2.0,
    angle: 4.7124
  },
  {
    name: 'Panier à linge',
    cat: 'other',
    x: -0.1139,
    z: -4.6335,
    w: 0.55,
    d: 0.3,
    h: 0.674,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Lave linge',
    cat: 'appliance',
    x: -0.0884,
    z: -5.1236,
    w: 0.59,
    d: 0.601,
    h: 0.842,
    elev: 0.0,
    angle: 4.7124
  },
  {
    name: 'Réfrigérateur / Congélateur',
    cat: 'appliance',
    x: 2.1572,
    z: -0.4972,
    w: 0.6,
    d: 0.66,
    h: 1.9,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Lavabo et meuble',
    cat: 'appliance',
    x: 0.4358,
    z: -0.1965,
    w: 0.5,
    d: 0.35,
    h: 0.76,
    elev: 0.2,
    angle: 1.5708
  },
  {
    name: 'WC',
    cat: 'appliance',
    x: 0.2587,
    z: 0.6017,
    w: 0.4,
    d: 0.8,
    h: 0.62,
    elev: 0.0,
    angle: 3.1416
  },
  {
    name: 'NiagaraFallsFrame',
    cat: 'screen',
    x: -5.385,
    z: 0.6358,
    w: 1.268,
    d: 0.021,
    h: 0.47,
    elev: 1.15,
    angle: 4.7124
  },
  {
    name: 'BESTA+BURS+TV+bench+white',
    cat: 'screen',
    x: -2.2708,
    z: 0.6701,
    w: 1.8,
    d: 0.42,
    h: 0.491,
    elev: 0.0,
    angle: 1.5708
  },
  {
    name: 'tv Panasonic',
    cat: 'screen',
    x: -2.1561,
    z: 0.6921,
    w: 1.269,
    d: 0.13,
    h: 0.699,
    elev: 0.49,
    angle: 4.7124
  },
  {
    name: 'Table Knoll',
    cat: 'table',
    x: -3.2329,
    z: -3.5872,
    w: 1.2,
    d: 1.2,
    h: 0.731,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Chaises tulipe Knoll',
    cat: 'seat',
    x: -3.2072,
    z: -4.194,
    w: 0.629,
    d: 0.594,
    h: 0.76,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Chaises tulipe Knoll',
    cat: 'seat',
    x: -3.8754,
    z: -3.5485,
    w: 0.629,
    d: 0.594,
    h: 0.76,
    elev: 0.0,
    angle: 4.7124
  },
  {
    name: 'Chaises tulipe Knoll',
    cat: 'seat',
    x: -2.5693,
    z: -3.5485,
    w: 0.629,
    d: 0.594,
    h: 0.76,
    elev: 0.0,
    angle: 1.5708
  },
  {
    name: 'Chaises tulipe Knoll',
    cat: 'seat',
    x: -3.2224,
    z: -2.9258,
    w: 0.629,
    d: 0.594,
    h: 0.76,
    elev: 0.0,
    angle: 3.1416
  },
  {
    name: 'Bibliotheque garnie',
    cat: 'storage',
    x: -3.9454,
    z: -5.397,
    w: 0.945,
    d: 0.389,
    h: 2.0,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Bibliotheque garnie',
    cat: 'storage',
    x: -3.0232,
    z: -5.397,
    w: 0.945,
    d: 0.389,
    h: 2.0,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Bibliotheque garnie',
    cat: 'storage',
    x: -2.101,
    z: -5.397,
    w: 0.945,
    d: 0.389,
    h: 2.0,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Banquette entrée',
    cat: 'seat',
    x: 1.0455,
    z: -1.9342,
    w: 1.1,
    d: 0.461,
    h: 0.71,
    elev: 0.005,
    angle: 0.0
  },
  {
    name: 'Buffet Salon',
    cat: 'storage',
    x: -0.8754,
    z: -3.6644,
    w: 1.6,
    d: 0.473,
    h: 0.887,
    elev: 0.0,
    angle: 1.5708
  },
  {
    name: 'Love-seat',
    cat: 'seat',
    x: -3.4892,
    z: -0.9225,
    w: 1.5,
    d: 1.178,
    h: 0.859,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Canapé Salon',
    cat: 'seat',
    x: -4.843,
    z: 0.6054,
    w: 1.105,
    d: 2.055,
    h: 0.85,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Meuble haut de cuisine',
    cat: 'storage',
    x: 1.9246,
    z: 1.9256,
    w: 2.6,
    d: 0.53,
    h: 0.622,
    elev: 1.86,
    angle: 0.0
  },
  {
    name: 'Meuble haut de cuisine',
    cat: 'storage',
    x: 0.3173,
    z: 1.6167,
    w: 1.08,
    d: 0.73,
    h: 0.6,
    elev: 1.89,
    angle: 1.5708
  },
  {
    name: 'Vélo',
    cat: 'other',
    x: 1.5208,
    z: 3.6296,
    w: 0.545,
    d: 1.9,
    h: 1.1,
    elev: 0.0,
    angle: 3.1416
  },
  {
    name: 'Vélo',
    cat: 'other',
    x: 2.4435,
    z: 3.5784,
    w: 0.545,
    d: 1.9,
    h: 1.1,
    elev: 0.0,
    angle: 3.1416
  },
  {
    name: 'Table',
    cat: 'table',
    x: -1.2518,
    z: 3.9408,
    w: 1.7,
    d: 1.0,
    h: 0.73,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Table',
    cat: 'table',
    x: 0.7333,
    z: 3.4816,
    w: 1.5,
    d: 0.45,
    h: 0.7,
    elev: 0.0,
    angle: 1.5708
  },
  {
    name: 'Chaise',
    cat: 'seat',
    x: -4.7102,
    z: 3.4212,
    w: 1.5,
    d: 0.7,
    h: 0.734,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Chaise',
    cat: 'seat',
    x: -3.6338,
    z: 4.5212,
    w: 1.5,
    d: 0.7,
    h: 0.734,
    elev: 0.0,
    angle: 1.5708
  },
  {
    name: 'Chaise',
    cat: 'seat',
    x: -3.6594,
    z: 3.4212,
    w: 0.7,
    d: 0.7,
    h: 0.734,
    elev: 0.0,
    angle: 0.0
  },
  {
    name: 'Table',
    cat: 'table',
    x: -4.6605,
    z: 4.4534,
    w: 0.7,
    d: 0.7,
    h: 0.4,
    elev: 0.0,
    angle: 0.0
  }
];
