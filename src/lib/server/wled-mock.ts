/**
 * Mock de l'API JSON WLED — contrôleur QuinLed Dig-Uno V3 (éclairage terrasse).
 *
 * Tant que la vraie carte n'est pas branchée sur le Wi-Fi (variable d'env
 * `WLED_URL` absente ou = 'mock'), la route /api/wled sert cet état SIMULÉ qui
 * imite fidèlement l'API JSON de WLED :
 *   GET  /json        → { state, info, effects, palettes }
 *   GET  /json/si     → { state, info }              (polling léger)
 *   GET  /json/state  → state
 *   GET  /json/info   → info
 *   GET  /json/eff    → string[]  (noms d'effets)
 *   GET  /json/pal    → string[]  (noms de palettes)
 *   POST /json/state  → applique un patch d'état partiel, renvoie le nouvel état
 *
 * Le jour du branchement : on pose `WLED_URL=http://<ip-du-Dig-Uno>` dans .env
 * (+ tunnel comme les autres bridges) et le proxy bascule sur le vrai module —
 * AUCUN changement côté store ni composants (l'UI est pilotée par les données).
 *
 * Deux segments modélisent les deux lignes LED physiques :
 *   - Segment 0 « Store »   → bras articulés du store banne (2 faisceaux mirroir)
 *   - Segment 1 « SàM Été » → véranda / salle à manger d'été (bandes en série)
 *
 * NB : l'état vit en mémoire du process Node (le service domo). Il persiste
 * entre les requêtes mais repart aux valeurs par défaut à chaque redémarrage —
 * comportement attendu pour un mock.
 */

/* ─── Catalogue d'effets WLED (ordre = index `fx`) ─────────────────────────
   Liste représentative et fidèle des effets WLED. Sur le vrai module, la liste
   renvoyée par /json/eff fait autorité (l'UI s'y adapte automatiquement). */
export const WLED_EFFECTS: string[] = [
  'Solid',
  'Blink',
  'Breathe',
  'Wipe',
  'Wipe Random',
  'Random Colors',
  'Sweep',
  'Dynamic',
  'Colorloop',
  'Rainbow',
  'Scan',
  'Scan Dual',
  'Fade',
  'Theater',
  'Theater Rainbow',
  'Running',
  'Saw',
  'Twinkle',
  'Dissolve',
  'Dissolve Rnd',
  'Sparkle',
  'Sparkle Dark',
  'Sparkle+',
  'Strobe',
  'Strobe Rainbow',
  'Strobe Mega',
  'Blink Rainbow',
  'Android',
  'Chase',
  'Chase Random',
  'Chase Rainbow',
  'Chase Flash',
  'Chase Flash Rnd',
  'Rainbow Runner',
  'Colorful',
  'Traffic Light',
  'Sweep Random',
  'Chase 2',
  'Aurora',
  'Stream',
  'Scanner',
  'Lighthouse',
  'Fireworks',
  'Rain',
  'Tetrix',
  'Fire Flicker',
  'Gradient',
  'Loading',
  'Rolling Balls',
  'Fairy',
  'Two Dots',
  'Fairytwinkle',
  'Running Dual',
  'Chase 3',
  'Tri Wipe',
  'Tri Fade',
  'Lightning',
  'ICU',
  'Multi Comet',
  'Scanner Dual',
  'Stream 2',
  'Oscillate',
  'Pride 2015',
  'Juggle',
  'Palette',
  'Fire 2012',
  'Colorwaves',
  'Bpm',
  'Fill Noise',
  'Noise 1',
  'Noise 2',
  'Noise 3',
  'Noise 4',
  'Colortwinkles',
  'Lake',
  'Meteor',
  'Meteor Smooth',
  'Railway',
  'Ripple',
  'Twinklefox',
  'Twinklecat',
  'Halloween Eyes',
  'Solid Pattern',
  'Solid Pattern Tri',
  'Spots',
  'Spots Fade',
  'Glitter',
  'Candle',
  'Fireworks Starburst',
  'Fireworks 1D',
  'Bouncing Balls',
  'Sinelon',
  'Sinelon Dual',
  'Sinelon Rainbow',
  'Popcorn',
  'Drip',
  'Plasma',
  'Percent',
  'Ripple Rainbow',
  'Heartbeat',
  'Pacifica',
  'Candle Multi',
  'Solid Glitter',
  'Sunrise',
  'Phased',
  'Twinkleup',
  'Noise Pal',
  'Sine',
  'Phased Noise',
  'Flow',
  'Chunchun',
  'Dancing Shadows',
  'Washing Machine',
  'Blends',
  'TV Simulator',
  'Dynamic Smooth'
];

/* ─── Catalogue de palettes WLED (ordre = index `pal`) ──────────────────── */
export const WLED_PALETTES: string[] = [
  'Default',
  'Random Cycle',
  'Color 1',
  'Colors 1&2',
  'Color Gradient',
  'Colors Only',
  'Party',
  'Cloud',
  'Lava',
  'Ocean',
  'Forest',
  'Rainbow',
  'Rainbow Bands',
  'Sunset',
  'Rivendell',
  'Breeze',
  'Red & Blue',
  'Yellowout',
  'Analogous',
  'Splash',
  'Pastel',
  'Sunset 2',
  'Beach',
  'Vintage',
  'Departure',
  'Landscape',
  'Beech',
  'Sherbet',
  'Hult',
  'Hult 64',
  'Drywet',
  'Jul',
  'Grintage',
  'Rewhi',
  'Tertiary',
  'Fire',
  'Icefire',
  'Cyane',
  'Light Pink',
  'Autumn',
  'Magenta',
  'Magred',
  'Yelmag',
  'Yelblu',
  'Orange & Teal',
  'Tiamat',
  'April Night',
  'Orangery',
  'C9',
  'Sakura',
  'Aurora',
  'Atlantica',
  'C9 2',
  'C9 New',
  'Temperature',
  'Aurora 2',
  'Retro Clown',
  'Candy',
  'Toxy Reaf',
  'Fairy Reaf',
  'Semi Blue',
  'Pink Candy',
  'Red Reaf',
  'Aqua Flash',
  'Yelblu Hot',
  'Lite Light',
  'Red Flash',
  'Blink Red',
  'Red Shift',
  'Red Tide',
  'Candy2'
];

interface MockSeg {
  id: number;
  start: number;
  stop: number;
  len: number;
  grp: number;
  spc: number;
  of: number;
  on: boolean;
  frz: boolean;
  bri: number;
  cct: number;
  /** Nom du segment (WLED 0.14+). */
  n: string;
  /** Couleurs : primaire, secondaire, tertiaire — chacune [r,g,b] ou [r,g,b,w] (RGBW). */
  col: number[][];
  fx: number;
  sx: number;
  ix: number;
  pal: number;
  c1: number;
  c2: number;
  c3: number;
  sel: boolean;
  rev: boolean;
  mi: boolean;
  o1: boolean;
  o2: boolean;
  o3: boolean;
  si: number;
  m12: number;
}

interface MockState {
  on: boolean;
  bri: number;
  transition: number;
  ps: number;
  pl: number;
  nl: { on: boolean; dur: number; mode: number; tbri: number; rem: number };
  udpn: { send: boolean; recv: boolean; sgrp: number; rgrp: number };
  lor: number;
  mainseg: number;
  seg: MockSeg[];
}

const SEG_STORE_LEN = 60; // bras du store banne (faisceaux mirroir)
const SEG_SAM_LEN = 150; // véranda / SàM Été (bandes en série)

const state: MockState = {
  on: true,
  bri: 160,
  transition: 7,
  ps: -1,
  pl: -1,
  nl: { on: false, dur: 60, mode: 1, tbri: 0, rem: -1 },
  udpn: { send: false, recv: true, sgrp: 1, rgrp: 1 },
  lor: 0,
  mainseg: 0,
  seg: [
    {
      id: 0,
      // Défaut = mode « Ensemble » : segment unique sur TOUTE la longueur
      // (Store + SàM), pour des effets continus. Le mode « Par ligne » re-scinde
      // en deux segments via un POST seg start/stop (cf. store setScope).
      start: 0,
      stop: SEG_STORE_LEN + SEG_SAM_LEN,
      len: SEG_STORE_LEN + SEG_SAM_LEN,
      grp: 1,
      spc: 0,
      of: 0,
      on: true,
      frz: false,
      bri: 255,
      cct: 127,
      n: 'Terrasse',
      // COB RGBW 4000K : par défaut, blanc propre via le canal W (RGB à 0).
      col: [
        [0, 0, 0, 220],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
      ],
      fx: 0,
      sx: 128,
      ix: 128,
      pal: 0,
      c1: 128,
      c2: 128,
      c3: 16,
      sel: true,
      rev: false,
      mi: false,
      o1: false,
      o2: false,
      o3: false,
      si: 0,
      m12: 0
    },
    {
      id: 1,
      // Désactivé par défaut (len 0) ; réactivé en mode « Par ligne ».
      start: SEG_STORE_LEN + SEG_SAM_LEN,
      stop: SEG_STORE_LEN + SEG_SAM_LEN,
      len: 0,
      grp: 1,
      spc: 0,
      of: 0,
      on: true,
      frz: false,
      bri: 220,
      cct: 127,
      n: 'SàM Été',
      col: [
        [0, 0, 0, 200],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
      ],
      fx: 0,
      sx: 128,
      ix: 128,
      pal: 0,
      c1: 128,
      c2: 128,
      c3: 16,
      sel: true,
      rev: false,
      mi: false,
      o1: false,
      o2: false,
      o3: false,
      si: 0,
      m12: 0
    }
  ]
};

let uptimeBase = 0; // incrémenté à chaque lecture d'info pour simuler la marche

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** Puissance estimée (W) — RGBW, varie avec on/luminosité/canaux (≈0,3 W/LED max). */
function estimatePowerW(): number {
  if (!state.on) return 0;
  const master = state.bri / 255;
  let w = 0;
  for (const s of state.seg) {
    if (!s.on) continue;
    const c = s.col[0] ?? [0, 0, 0, 0];
    const intensity = ((c[0] || 0) + (c[1] || 0) + (c[2] || 0) + (c[3] || 0)) / (4 * 255);
    w += s.len * 0.3 * intensity * (s.bri / 255) * master;
  }
  return Math.round(w);
}

function buildInfo() {
  const count = state.seg.reduce((a, s) => a + s.len, 0);
  uptimeBase += 5;
  return {
    ver: '0.15.0',
    vid: 2410270,
    leds: {
      count,
      pwr: estimatePowerW(),
      fps: state.on ? 42 : 0,
      maxpwr: 0,
      maxseg: 32,
      seglc: state.seg.map(() => 3),
      lc: 3,
      rgbw: true,
      wv: 1,
      cct: 0
    },
    str: false,
    name: 'QuinLED-Terrasse',
    udpport: 21324,
    live: false,
    liveseg: -1,
    lm: '',
    lip: '',
    ws: 0,
    fxcount: WLED_EFFECTS.length,
    palcount: WLED_PALETTES.length,
    cpalcount: 0,
    maps: [{ id: 0 }],
    wifi: { bssid: '00:00:00:00:00:00', rssi: -56, signal: 88, channel: 6 },
    fs: { u: 12, t: 983, pmt: 0 },
    ndc: -1,
    arch: 'esp32',
    core: 'v3.3.6',
    lwip: 0,
    freeheap: 182_000,
    uptime: 8123 + uptimeBase,
    time: new Date().toISOString(),
    opt: 79,
    brand: 'WLED',
    product: 'QuinLED Dig-Uno (mock)',
    mac: 'a842e3000000',
    ip: '0.0.0.0'
  };
}

function mergeSeg(seg: MockSeg, p: Record<string, unknown>): void {
  if (p.on === true || p.on === false) seg.on = p.on;
  else if (p.on === 't') seg.on = !seg.on;
  // Bornes du segment (fusion/séparation des lignes) → recalcule la longueur.
  if (typeof p.start === 'number') seg.start = clampInt(p.start, 0, 100000, seg.start);
  if (typeof p.stop === 'number') seg.stop = clampInt(p.stop, 0, 100000, seg.stop);
  if (typeof p.start === 'number' || typeof p.stop === 'number')
    seg.len = Math.max(0, seg.stop - seg.start);
  if (typeof p.bri === 'number') seg.bri = clampInt(p.bri, 0, 255, seg.bri);
  if (typeof p.fx === 'number') seg.fx = clampInt(p.fx, 0, WLED_EFFECTS.length - 1, seg.fx);
  if (typeof p.pal === 'number') seg.pal = clampInt(p.pal, 0, WLED_PALETTES.length - 1, seg.pal);
  if (typeof p.sx === 'number') seg.sx = clampInt(p.sx, 0, 255, seg.sx);
  if (typeof p.ix === 'number') seg.ix = clampInt(p.ix, 0, 255, seg.ix);
  if (typeof p.cct === 'number') seg.cct = clampInt(p.cct, 0, 255, seg.cct);
  if (typeof p.n === 'string') seg.n = p.n.slice(0, 32);
  if (typeof p.sel === 'boolean') seg.sel = p.sel;
  if (typeof p.rev === 'boolean') seg.rev = p.rev;
  if (typeof p.frz === 'boolean') seg.frz = p.frz;
  if (Array.isArray(p.col)) {
    // RGBW : chaque entrée peut porter 4 canaux [r,g,b,w].
    const cols: number[][] = [[...seg.col[0]], [...seg.col[1]], [...seg.col[2]]];
    p.col.forEach((entry, i) => {
      if (i > 2 || !Array.isArray(entry)) return;
      const base = cols[i] ?? [0, 0, 0, 0];
      cols[i] = [
        clampInt(entry[0], 0, 255, base[0] ?? 0),
        clampInt(entry[1], 0, 255, base[1] ?? 0),
        clampInt(entry[2], 0, 255, base[2] ?? 0),
        clampInt(entry[3], 0, 255, base[3] ?? 0)
      ];
    });
    seg.col = cols;
  }
}

/** Applique un patch d'état partiel (corps d'un POST /json/state). */
export function applyState(patch: unknown): void {
  if (!patch || typeof patch !== 'object') return;
  const p = patch as Record<string, unknown>;

  if (p.on === true || p.on === false) state.on = p.on;
  else if (p.on === 't') state.on = !state.on;

  if (typeof p.bri === 'number') {
    state.bri = clampInt(p.bri, 0, 255, state.bri);
    if (state.bri > 0 && p.on === undefined) state.on = true;
  }
  if (typeof p.transition === 'number') state.transition = clampInt(p.transition, 0, 255, 7);
  if (typeof p.mainseg === 'number')
    state.mainseg = clampInt(p.mainseg, 0, state.seg.length - 1, state.mainseg);

  if (p.nl && typeof p.nl === 'object') {
    const nl = p.nl as Record<string, unknown>;
    if (typeof nl.on === 'boolean') state.nl.on = nl.on;
    if (typeof nl.dur === 'number') state.nl.dur = clampInt(nl.dur, 1, 255, state.nl.dur);
  }

  if (Array.isArray(p.seg)) {
    for (const incoming of p.seg) {
      if (!incoming || typeof incoming !== 'object') continue;
      const obj = incoming as Record<string, unknown>;
      const id = typeof obj.id === 'number' ? obj.id : state.mainseg;
      const seg = state.seg.find((s) => s.id === id);
      if (seg) mergeSeg(seg, obj);
    }
  }
}

/**
 * Réponse à une requête GET sur l'API JSON.
 * @param sub sous-chemin après `json/` : '' | 'state' | 'info' | 'si' | 'eff' | 'pal'
 */
export function wledGet(sub: string): unknown {
  switch (sub) {
    case 'state':
      return state;
    case 'info':
      return buildInfo();
    case 'si':
      return { state, info: buildInfo() };
    case 'eff':
      return WLED_EFFECTS;
    case 'pal':
      return WLED_PALETTES;
    case '':
    default:
      return { state, info: buildInfo(), effects: WLED_EFFECTS, palettes: WLED_PALETTES };
  }
}

/** Applique un POST /json/state et renvoie le nouvel état (comme WLED). */
export function wledPostState(patch: unknown): unknown {
  applyState(patch);
  return state;
}
