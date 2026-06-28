/**
 * Store WLED — pilotage de l'éclairage terrasse (QuinLed Dig-Uno V3).
 *
 * Parle à /api/wled (proxy serveur), qui sert un MOCK tant que le vrai module
 * n'est pas branché (cf. src/lib/server/wled-mock.ts). L'UI est entièrement
 * pilotée par les données renvoyées (effets, palettes, segments) → identique une
 * fois la carte réelle sur le réseau (il suffira de poser WLED_URL dans .env).
 *
 * Ruban : COB RGBW 4000K → chaque couleur a un 4ᵉ canal BLANC dédié (W). La
 * lumière perçue = RGB mélangé additivement avec le blanc 4000K. On garde donc
 * `col` (teinte RGB) et `white` (canal W) séparés, comme l'app WLED native.
 *
 * Conventions Domo : runes $state, polling visibility-aware (pause en arrière-
 * plan + refetch au retour de visibilité), cycle de vie refcounté via acquire(),
 * commandes optimistes (reflet immédiat + POST, resync GET au prochain tick).
 *
 * Modèle : deux segments WLED = deux lignes LED physiques :
 *   - id 0 « Store »   → bras articulés du store banne
 *   - id 1 « SàM Été » → véranda / salle à manger d'été
 */

export type RGB = [number, number, number];

/** Teinte sRGB approximative d'un blanc 4000K (neutre légèrement chaud). */
export const WHITE_4000K: RGB = [255, 223, 191];

export interface WledSegment {
  id: number;
  name: string;
  on: boolean;
  /** Luminosité du segment (0-255). */
  bri: number;
  /** Couleur (teinte RGB) — s'ajoute au canal blanc. */
  col: RGB;
  /** Canal blanc dédié 4000K (0-255). */
  white: number;
  /** Index d'effet (dans `effects`). */
  fx: number;
  /** Vitesse de l'effet (0-255). */
  sx: number;
  /** Intensité de l'effet (0-255). */
  ix: number;
  /** Index de palette (dans `palettes`). */
  pal: number;
  /** Nombre de LED du segment. */
  len: number;
}

/**
 * Couleur RÉELLEMENT perçue = teinte RGB + canal blanc 4000K (additif).
 * Sert au rendu visuel (barre d'aperçu, pastilles) — pas envoyée au module.
 */
export function effectiveColor(col: RGB, white: number): RGB {
  const w = white / 255;
  return [
    Math.min(255, Math.round(col[0] + WHITE_4000K[0] * w)),
    Math.min(255, Math.round(col[1] + WHITE_4000K[1] * w)),
    Math.min(255, Math.round(col[2] + WHITE_4000K[2] * w))
  ];
}

/** Ambiances rapides (appliquées aux deux segments d'un coup). */
export interface WledAmbiance {
  key: string;
  label: string;
  /** Couleur représentative pour la pastille de l'UI. */
  swatch: string;
  off?: boolean;
  bri?: number;
  col?: RGB;
  /** Canal blanc 4000K (0-255). */
  white?: number;
  /** Nom d'effet (résolu en index sur le module). */
  fx?: string;
  /** Nom de palette (résolu en index sur le module). */
  pal?: string;
  sx?: number;
  ix?: number;
}

export const WLED_AMBIANCES: WledAmbiance[] = [
  {
    key: 'blanc',
    label: 'Blanc 4000K',
    swatch: 'rgb(255 223 191)',
    bri: 255,
    col: [0, 0, 0],
    white: 255,
    fx: 'Solid'
  },
  {
    key: 'warm',
    label: 'Blanc chaud',
    swatch: 'rgb(255 180 110)',
    bri: 255,
    col: [255, 120, 40],
    white: 150,
    fx: 'Solid'
  },
  {
    key: 'soiree',
    label: 'Soirée',
    swatch: 'rgb(255 140 70)',
    bri: 90,
    col: [255, 110, 45],
    white: 40,
    fx: 'Solid'
  },
  {
    key: 'diner',
    label: 'Dîner',
    swatch: 'rgb(255 110 70)',
    bri: 150,
    col: [255, 80, 50],
    white: 70,
    fx: 'Breathe',
    sx: 40,
    ix: 128
  },
  {
    key: 'sunset',
    label: 'Coucher de soleil',
    swatch: 'linear-gradient(90deg,#ff5e62,#ff9966,#ffd56b)',
    bri: 200,
    col: [0, 0, 0],
    white: 0,
    fx: 'Colorloop',
    pal: 'Sunset',
    sx: 60,
    ix: 128
  },
  {
    key: 'fete',
    label: 'Fête',
    swatch: 'linear-gradient(90deg,#f0f,#0ff,#ff0)',
    bri: 255,
    col: [0, 0, 0],
    white: 0,
    fx: 'Rainbow',
    pal: 'Party',
    sx: 200,
    ix: 180
  },
  {
    key: 'bougie',
    label: 'Bougie',
    swatch: 'rgb(255 120 30)',
    bri: 160,
    col: [255, 110, 25],
    white: 30,
    fx: 'Candle',
    sx: 110,
    ix: 130
  },
  { key: 'off', label: 'Éteint', swatch: 'transparent', off: true }
];

function clamp(v: number, min = 0, max = 255): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

const POLL_MS = 5_000;
const TIMEOUT_MS = 8_000;

class WledStore {
  // ─── Connexion / source ───────────────────────────
  /** Le module (ou le mock) répond-il ? */
  connected = $state(false);
  /** L'état est-il servi par le MOCK (vrai module pas encore branché) ? */
  isMock = $state(false);
  lastUpdate = $state<Date | null>(null);
  lastError = $state<string | null>(null);

  // ─── État maître ──────────────────────────────────
  /** Alimentation générale. */
  on = $state(false);
  /** Luminosité maître (0-255). */
  bri = $state(128);
  /** Nom du module (info.name). */
  name = $state('Éclairage terrasse');
  /** Ruban RGBW (canal blanc dédié) — pilote l'affichage du réglage « Blanc ». */
  rgbw = $state(false);

  // ─── Segments + catalogues ────────────────────────
  segments = $state<WledSegment[]>([]);
  effects = $state<string[]>([]);
  palettes = $state<string[]>([]);

  #timer: ReturnType<typeof setInterval> | null = null;
  #vis: (() => void) | null = null;
  #metaLoaded = false;

  /** Index de l'effet « Solid » (pour savoir si un segment affiche une couleur fixe). */
  solidFx = $derived(Math.max(0, this.effects.indexOf('Solid')));

  // ─── Lecture ──────────────────────────────────────
  #applyState(s: Record<string, unknown>): void {
    if (typeof s.on === 'boolean') this.on = s.on;
    if (typeof s.bri === 'number') this.bri = clamp(s.bri);
    if (Array.isArray(s.seg)) {
      const segs: WledSegment[] = [];
      let sawRgbw = false;
      for (const raw of s.seg) {
        if (!raw || typeof raw !== 'object') continue;
        const seg = raw as Record<string, unknown>;
        const start = typeof seg.start === 'number' ? seg.start : 0;
        const stop = typeof seg.stop === 'number' ? seg.stop : 0;
        const len = typeof seg.len === 'number' ? seg.len : Math.max(0, stop - start);
        if (len <= 0) continue; // segment inactif

        // Couleur primaire : [r,g,b] ou [r,g,b,w] (RGBW).
        let col: RGB = [255, 255, 255];
        let white = 0;
        if (Array.isArray(seg.col) && Array.isArray(seg.col[0])) {
          const c = seg.col[0] as unknown[];
          col = [clamp(Number(c[0]) || 0), clamp(Number(c[1]) || 0), clamp(Number(c[2]) || 0)];
          if (c.length >= 4) {
            white = clamp(Number(c[3]) || 0);
            sawRgbw = true;
          }
        }

        const id = typeof seg.id === 'number' ? seg.id : segs.length;
        segs.push({
          id,
          name: typeof seg.n === 'string' && seg.n.trim() ? seg.n : `Segment ${id + 1}`,
          on: seg.on !== false,
          bri: typeof seg.bri === 'number' ? clamp(seg.bri) : 255,
          col,
          white,
          fx: typeof seg.fx === 'number' ? seg.fx : 0,
          sx: typeof seg.sx === 'number' ? clamp(seg.sx) : 128,
          ix: typeof seg.ix === 'number' ? clamp(seg.ix) : 128,
          pal: typeof seg.pal === 'number' ? seg.pal : 0,
          len
        });
      }
      if (sawRgbw) this.rgbw = true;
      if (segs.length) this.segments = segs;
    }
  }

  #applyInfo(info: Record<string, unknown>): void {
    if (typeof info.name === 'string' && info.name) this.name = info.name;
    const leds = info.leds as Record<string, unknown> | undefined;
    if (leds) {
      // RGBW signalé de plusieurs façons selon la version WLED : booléen `rgbw`,
      // ou bit blanc dans les capacités `lc` (bit 1 = 2). On combine (OR).
      if (leds.rgbw === true) this.rgbw = true;
      if (typeof leds.lc === 'number' && (leds.lc & 2) !== 0) this.rgbw = true;
    }
  }

  /** Charge effets + palettes (rarement changeants) — une seule fois. */
  async loadMeta(): Promise<void> {
    try {
      const res = await fetch('/api/wled/json', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.isMock = res.headers.get('x-wled-source') === 'mock';
      const d = await res.json();
      if (Array.isArray(d?.effects))
        this.effects = d.effects.filter((x: unknown) => typeof x === 'string');
      if (Array.isArray(d?.palettes))
        this.palettes = d.palettes.filter((x: unknown) => typeof x === 'string');
      if (d?.info) this.#applyInfo(d.info);
      if (d?.state) this.#applyState(d.state);
      this.connected = true;
      this.lastError = null;
      this.lastUpdate = new Date();
      this.#metaLoaded = true;
    } catch (e) {
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : 'erreur';
    }
  }

  /** Rafraîchit l'état courant (polling léger /json/si). */
  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/wled/json/si', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.isMock = res.headers.get('x-wled-source') === 'mock';
      const d = await res.json();
      if (d?.info) this.#applyInfo(d.info);
      if (d?.state) this.#applyState(d.state);
      this.connected = true;
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : 'erreur';
    }
  }

  // ─── Cycle de vie (refcount via acquire) ──────────
  connect(): void {
    if (this.#timer || typeof document === 'undefined') return;
    if (!this.#metaLoaded) this.loadMeta();
    this.refresh();
    this.#timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh();
    }, POLL_MS);
    this.#vis = () => {
      if (document.visibilityState === 'visible') {
        if (!this.#metaLoaded) this.loadMeta();
        this.refresh();
      }
    };
    document.addEventListener('visibilitychange', this.#vis);
  }

  disconnect(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#vis) {
      document.removeEventListener('visibilitychange', this.#vis);
      this.#vis = null;
    }
  }

  // ─── Commandes (optimistes + POST, resync au tick suivant) ────────
  async #post(partial: object): Promise<void> {
    try {
      const res = await fetch('/api/wled/json/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      // WLED renvoie le nouvel état (le mock aussi) → reconciliation immédiate.
      if (d && typeof d === 'object' && ('seg' in d || 'bri' in d || 'on' in d)) {
        this.#applyState(d as Record<string, unknown>);
      }
      this.connected = true;
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'erreur';
      this.refresh(); // resync sur échec
    }
  }

  #seg(id: number): WledSegment | undefined {
    return this.segments.find((s) => s.id === id);
  }

  /** Construit l'entrée `col` RGBW [[r,g,b,w]] pour un segment. */
  #colPayload(rgb: RGB, white: number): number[][] {
    return [[rgb[0], rgb[1], rgb[2], clamp(white)]];
  }

  // Maître
  async setOn(on: boolean): Promise<void> {
    this.on = on;
    await this.#post({ on });
  }
  toggle(): Promise<void> {
    return this.setOn(!this.on);
  }
  async setBri(v: number): Promise<void> {
    const b = clamp(v);
    this.bri = b;
    if (b > 0) this.on = true;
    await this.#post({ on: b > 0, bri: b });
  }

  // Segment
  async setSegOn(id: number, on: boolean): Promise<void> {
    const s = this.#seg(id);
    if (s) s.on = on;
    await this.#post({ seg: [{ id, on }] });
  }
  async setSegBri(id: number, v: number): Promise<void> {
    const b = clamp(v);
    const s = this.#seg(id);
    if (s) {
      s.bri = b;
      if (b > 0) s.on = true;
    }
    await this.#post({ seg: [{ id, on: b > 0 ? true : undefined, bri: b }] });
  }
  async setSegColor(id: number, rgb: RGB): Promise<void> {
    const s = this.#seg(id);
    const white = s?.white ?? 0;
    if (s) {
      s.col = rgb;
      s.on = true;
    }
    await this.#post({ seg: [{ id, on: true, col: this.#colPayload(rgb, white) }] });
  }
  /** Canal blanc 4000K (RGBW). */
  async setSegWhite(id: number, white: number): Promise<void> {
    const w = clamp(white);
    const s = this.#seg(id);
    const rgb = s?.col ?? [0, 0, 0];
    if (s) {
      s.white = w;
      if (w > 0) s.on = true;
    }
    await this.#post({
      seg: [{ id, on: w > 0 ? true : undefined, col: this.#colPayload(rgb, w) }]
    });
  }
  async setSegEffect(id: number, fx: number): Promise<void> {
    const s = this.#seg(id);
    if (s) s.fx = fx;
    await this.#post({ seg: [{ id, fx }] });
  }
  async setSegPalette(id: number, pal: number): Promise<void> {
    const s = this.#seg(id);
    if (s) s.pal = pal;
    await this.#post({ seg: [{ id, pal }] });
  }
  async setSegSpeed(id: number, sx: number): Promise<void> {
    const v = clamp(sx);
    const s = this.#seg(id);
    if (s) s.sx = v;
    await this.#post({ seg: [{ id, sx: v }] });
  }
  async setSegIntensity(id: number, ix: number): Promise<void> {
    const v = clamp(ix);
    const s = this.#seg(id);
    if (s) s.ix = v;
    await this.#post({ seg: [{ id, ix: v }] });
  }

  /** Applique une ambiance aux DEUX segments d'un coup. */
  async applyAmbiance(key: string): Promise<void> {
    const a = WLED_AMBIANCES.find((x) => x.key === key);
    if (!a) return;
    if (a.off) {
      await this.setOn(false);
      return;
    }
    const fxIdx = a.fx ? Math.max(0, this.effects.indexOf(a.fx)) : undefined;
    const palIdx = a.pal ? Math.max(0, this.palettes.indexOf(a.pal)) : undefined;
    const ids = this.segments.length ? this.segments.map((s) => s.id) : [0, 1];

    // Reflet optimiste local
    for (const s of this.segments) {
      s.on = true;
      if (a.bri !== undefined) s.bri = clamp(a.bri);
      if (a.col) s.col = a.col;
      if (a.white !== undefined) s.white = clamp(a.white);
      if (fxIdx !== undefined) s.fx = fxIdx;
      if (palIdx !== undefined) s.pal = palIdx;
      if (a.sx !== undefined) s.sx = clamp(a.sx);
      if (a.ix !== undefined) s.ix = clamp(a.ix);
    }
    this.on = true;

    const seg = ids.map((id) => {
      const cur = this.#seg(id);
      const o: Record<string, unknown> = { id, on: true };
      if (a.bri !== undefined) o.bri = clamp(a.bri);
      if (a.col || a.white !== undefined) {
        const rgb = a.col ?? cur?.col ?? [0, 0, 0];
        const w = a.white ?? cur?.white ?? 0;
        o.col = this.#colPayload(rgb as RGB, w);
      }
      if (fxIdx !== undefined) o.fx = fxIdx;
      if (palIdx !== undefined) o.pal = palIdx;
      if (a.sx !== undefined) o.sx = clamp(a.sx);
      if (a.ix !== undefined) o.ix = clamp(a.ix);
      return o;
    });
    await this.#post({ on: true, seg });
  }
}

export const wled = new WledStore();
