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
 * ⚠️ Au branchement du vrai module : régler « Auto-calculate white » sur None
 * dans les LED settings, sinon le firmware recalcule W depuis le RGB et le
 * slider Blanc sera ignoré.
 *
 * Conventions Domo : runes $state, polling visibility-aware (pause en arrière-
 * plan + refetch au retour de visibilité), cycle de vie refcounté via acquire(),
 * commandes optimistes (reflet immédiat + POST). Le resync (poll/écho POST) est
 * GELÉ pendant une interaction continue (drag d'un slider) pour ne pas faire
 * sauter le curseur sous le doigt, et l'état des segments est mis à jour
 * IN-PLACE (identité référentielle préservée).
 *
 * Modèle : les lignes LED physiques = segments WLED (liste LINES), 1 bus :
 *   - « SàM d'Été » [0,52)  → ruban principal (éclaire la salle à manger d'été)
 *   - « Store »    [52,102) → les 2 bras du store banne, 2×50 LEDs en PARALLÈLE
 *     (50 px logiques), chacun derrière SON amplificateur de signal dans la
 *     boîte de raccordement n°2 (les amplis ont remplacé les LEDs
 *     régénératrices soudées : le Y passif corrompait le signal par réflexions,
 *     et les soudures sur pads étaient mécaniquement fragiles).
 * Plus AUCUNE LED de service ni masque : uniquement des pixels visibles.
 * Future ligne « SàM Été » (2ᵉ sortie du Dig-Uno) : ajouter une entrée LINES.
 */

import type { PaletteMap } from '$lib/wled/preview-model';

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
  /**
   * Couleurs 2 et 3 du segment. WLED en porte TROIS : la 1re est celle qu'on
   * règle dans la feuille, les deux autres n'existent que pour les palettes
   * dynamiques (« Colors 1&2 », « Color Gradient »…) qui s'y réfèrent par
   * `c2`/`c3`. Sans elles, ces palettes se peignaient en aplat.
   */
  col2: RGB;
  col3: RGB;
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
 * Couleur RÉELLEMENT perçue = teinte RGB + canal blanc 4000K (additif), clampée.
 * @param weight pondération du canal blanc (1 = physique réel ; <1 = aperçu,
 *   pour éviter que tout vire au blanc dès qu'on monte le blanc et garder la
 *   teinte lisible). Sert au rendu visuel uniquement (jamais envoyé au module).
 */
export function effectiveColor(col: RGB, white: number, weight = 1): RGB {
  const w = (white / 255) * weight;
  return [
    Math.min(255, Math.round(col[0] + WHITE_4000K[0] * w)),
    Math.min(255, Math.round(col[1] + WHITE_4000K[1] * w)),
    Math.min(255, Math.round(col[2] + WHITE_4000K[2] * w))
  ];
}

/** Couleur d'aperçu (blanc atténué pour garder la teinte distinguable). */
export function previewColor(col: RGB, white: number): RGB {
  return effectiveColor(col, white, 0.6);
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
  /** Nom d'effet (résolu en index sur le module ; repli sur le suivant si absent). */
  fx?: string | string[];
  /** Nom de palette (résolu en index sur le module ; repli sur le suivant si absent). */
  pal?: string | string[];
  sx?: number;
  ix?: number;
}

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
    fx: ['Colorloop', 'Colorwaves', 'Gradient'],
    pal: ['Sunset', 'Sunset 2', 'Orangery'],
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
    fx: ['Rainbow', 'Colorloop'],
    pal: ['Party', 'Rainbow'],
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
    fx: ['Candle', 'Candle Multi', 'Flicker'],
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
/** Durée de gel du resync après la dernière interaction continue (ms). */
const INTERACT_HOLD_MS = 900;

export type WledScope = 'together' | 'perLine';

// Lignes physiques chaînées sur la sortie 1 du Dig-Uno, dans l'ordre du câblage.
// La longueur TOTALE est lue sur le module (info.leds.count) — JAMAIS codée en
// dur : `stop` absent = jusqu'au bout du ruban, la dernière ligne absorbe donc
// une extension future sans retouche. Tant que le module ne compte que la
// ligne 1, le mode « Par ligne » est sans objet (canSplit=false, bascule masquée).
//   [0,52)   « Store »         — 52 groupes COB WS2814 comptés le 2026-07-06
//   [0,52)   « SàM d'Été » — 52 groupes COB WS2814 (ruban principal)
//   [52,102) « Store »      — 2×50 LEDs de bras en parallèle = 50 px logiques
const LINES: { n: string; start: number; stop?: number }[] = [
  { n: "SàM d'Été", start: 0, stop: 52 },
  { n: 'Store', start: 52 }
];
/** Seuil d'existence de la 2ᵉ ligne (début de la première ligne optionnelle). */
const SEG_SPLIT = LINES[1].start;

class WledStore {
  // ─── Connexion / source ───────────────────────────
  /** Le module (ou le mock) répond-il avec une réponse WLED valide ? */
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
  /** Nombre TOTAL de pixels du module (info.leds.count) — source de vérité du layout. */
  total = $state(0);

  // ─── Segments + catalogues ────────────────────────
  segments = $state<WledSegment[]>([]);
  effects = $state<string[]>([]);
  palettes = $state<string[]>([]);
  /**
   * Couleurs RÉELLES des palettes (index WLED → dégradé), lues une fois sur le
   * module. Vide tant qu'il n'a pas répondu : l'aperçu retombe alors sur sa
   * table écrite à la main — on ne bloque jamais l'affichage là-dessus.
   */
  paletteColors = $state<PaletteMap>({});
  #paletteFetch: Promise<void> | null = null;

  #timer: ReturnType<typeof setInterval> | null = null;
  #vis: (() => void) | null = null;
  #metaLoaded = false;
  /** Horodatage de la dernière interaction continue (drag). */
  #lastTouch = 0;

  /** Index de l'effet « Solid » (-1 si le catalogue n'est pas chargé). */
  solidFx = $derived(this.effects.indexOf('Solid'));

  /** Mode déduit de la disposition réelle : 1 segment = Ensemble, ≥2 = Par ligne. */
  scope = $derived<WledScope>(this.segments.length > 1 ? 'perLine' : 'together');

  /** Le découpage « Par ligne » n'a de sens que si la 2ᵉ ligne existe vraiment. */
  canSplit = $derived(this.total > SEG_SPLIT);

  /** Numéro de séquence des ÉCRITURES (drag ou POST). Une lecture (GET) qui a
   *  démarré à seq=N ne doit PLUS s'appliquer si une écriture a eu lieu depuis
   *  (seq a changé) : sa charge est antérieure au dernier ordre. Couvre la
   *  fenêtre où le GET était déjà parti AVANT la commande et revient après. */
  #cmdSeq = 0;

  /** Une interaction continue est-elle en cours (gel du resync) ? */
  #busy(): boolean {
    return Date.now() - this.#lastTouch < INTERACT_HOLD_MS;
  }
  #touch(): void {
    this.#lastTouch = Date.now();
    this.#cmdSeq++;
  }

  // ─── Lecture ──────────────────────────────────────
  /** Une réponse ressemble-t-elle à du WLED (anti faux-positif de connexion) ? */
  #looksWled(d: unknown): boolean {
    if (!d || typeof d !== 'object') return false;
    const o = d as Record<string, unknown>;
    const state = (o.state ?? o) as Record<string, unknown>;
    return Array.isArray(state.seg) || typeof state.on === 'boolean' || Array.isArray(o.effects);
  }

  /** Met à jour les segments IN-PLACE (préserve l'identité des objets). */
  #applyState(s: Record<string, unknown>): void {
    if (typeof s.on === 'boolean') this.on = s.on;
    if (typeof s.bri === 'number') this.bri = clamp(s.bri);
    if (!Array.isArray(s.seg)) return;

    let sawRgbw = false;
    const byId = new Map(this.segments.map((seg) => [seg.id, seg]));
    const next: WledSegment[] = [];

    for (const raw of s.seg) {
      if (!raw || typeof raw !== 'object') continue;
      const seg = raw as Record<string, unknown>;
      const start = typeof seg.start === 'number' ? seg.start : 0;
      const stop = typeof seg.stop === 'number' ? seg.stop : 0;
      const len = typeof seg.len === 'number' ? seg.len : Math.max(0, stop - start);
      if (len <= 0) continue; // segment inactif

      // Couleurs du segment : WLED en renvoie trois, chacune [r,g,b] ou
      // [r,g,b,w] (RGBW). La 1re porte la teinte réglable + le canal blanc ;
      // les 2e et 3e ne servent qu'aux palettes qui s'y réfèrent (c2/c3).
      const readCol = (i: number): RGB | null => {
        if (!Array.isArray(seg.col) || !Array.isArray(seg.col[i])) return null;
        const c = seg.col[i] as unknown[];
        return [clamp(Number(c[0]) || 0), clamp(Number(c[1]) || 0), clamp(Number(c[2]) || 0)];
      };

      let col: RGB = [255, 255, 255];
      let white = 0;
      if (Array.isArray(seg.col) && Array.isArray(seg.col[0])) {
        const c = seg.col[0] as unknown[];
        col = readCol(0) ?? col;
        if (c.length >= 4) {
          white = clamp(Number(c[3]) || 0);
          sawRgbw = true;
        }
      }
      const col2: RGB = readCol(1) ?? [0, 0, 0];
      const col3: RGB = readCol(2) ?? [0, 0, 0];

      const id = typeof seg.id === 'number' ? seg.id : next.length;
      const fields = {
        name: typeof seg.n === 'string' && seg.n.trim() ? seg.n : `Segment ${id + 1}`,
        on: seg.on !== false,
        bri: typeof seg.bri === 'number' ? clamp(seg.bri) : 255,
        col,
        white,
        col2,
        col3,
        fx: typeof seg.fx === 'number' ? seg.fx : 0,
        sx: typeof seg.sx === 'number' ? clamp(seg.sx) : 128,
        ix: typeof seg.ix === 'number' ? clamp(seg.ix) : 128,
        pal: typeof seg.pal === 'number' ? seg.pal : 0,
        len
      };

      const existing = byId.get(id);
      if (existing) {
        Object.assign(existing, fields); // mutation in-place → identité préservée
        next.push(existing);
      } else {
        next.push({ id, ...fields });
      }
    }

    if (sawRgbw) this.rgbw = true;
    if (next.length) {
      // Réassigne seulement si la topologie change (évite un churn inutile).
      const sameTopology =
        next.length === this.segments.length && next.every((s2, i) => s2 === this.segments[i]);
      if (!sameTopology) this.segments = next;
    }
  }

  #applyInfo(info: Record<string, unknown>): void {
    if (typeof info.name === 'string' && info.name) this.name = info.name;
    const leds = info.leds as Record<string, unknown> | undefined;
    if (leds) {
      if (typeof leds.count === 'number' && leds.count > 0) this.total = leds.count;
      // RGBW signalé de plusieurs façons selon la version WLED : booléen `rgbw`,
      // ou bit blanc dans les capacités `lc`. On combine (OR) — ne jamais repasser à false.
      if (leds.rgbw === true) this.rgbw = true;
      if (typeof leds.lc === 'number' && (leds.lc & 2) !== 0) this.rgbw = true;
    }
  }

  /** Charge effets + palettes (rarement changeants). */
  async loadMeta(): Promise<void> {
    const seq = this.#cmdSeq; // invalide l'application d'état si une commande survient pendant le GET
    try {
      const res = await fetch('/api/wled/json', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (!this.#looksWled(d)) throw new Error('réponse non-WLED');
      this.isMock = res.headers.get('x-wled-source') === 'mock';
      if (Array.isArray(d?.effects))
        this.effects = d.effects.filter((x: unknown) => typeof x === 'string');
      if (Array.isArray(d?.palettes))
        this.palettes = d.palettes.filter((x: unknown) => typeof x === 'string');
      if (d?.info) this.#applyInfo(d.info);
      if (d?.state && !this.#busy() && !this.#sending && this.#cmdSeq === seq)
        this.#applyState(d.state);
      this.connected = true;
      this.lastError = null;
      this.lastUpdate = new Date();
      this.#metaLoaded = this.effects.length > 0;
      this.#loadPaletteColors();
    } catch (e) {
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : 'erreur';
    }
  }

  /**
   * Charge les couleurs de palettes — une fois, en tâche de fond.
   *
   * Jamais attendu par l'appelant : l'aperçu doit s'afficher tout de suite,
   * avec ses couleurs de repli, et se corriger quand celles du module
   * arrivent. Un échec laisse la porte ouverte à un nouvel essai (le module
   * de la terrasse est à -73 dBm et peut très bien manquer le premier
   * rendez-vous) ; un succès ferme définitivement — ces couleurs ne changent
   * qu'à un flashage de firmware.
   */
  #loadPaletteColors(): void {
    if (this.#paletteFetch) return;
    this.#paletteFetch = (async () => {
      try {
        const res = await fetch('/api/wled/palettes', { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return;
        const d = await res.json();
        if (d?.palettes && typeof d.palettes === 'object') this.paletteColors = d.palettes;
      } catch {
        /* silencieux : la table de repli prend le relais */
      }
    })().finally(() => {
      if (!Object.keys(this.paletteColors).length) this.#paletteFetch = null;
    });
  }

  /** Rafraîchit l'état courant (polling léger /json/si). Gelé pendant un drag
   *  ou tant que des commandes sont en file (un GET intercalé renverrait un
   *  état antérieur au dernier ordre et ferait « sauter » l'UI en arrière). */
  async refresh(): Promise<void> {
    if (this.#busy() || this.#sending) return; // ne pas écraser un réglage en cours
    if (!this.#metaLoaded) this.loadMeta(); // retry catalogue tant qu'absent
    const seq = this.#cmdSeq;
    try {
      const res = await fetch('/api/wled/json/si', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (!this.#looksWled(d)) throw new Error('réponse non-WLED');
      this.isMock = res.headers.get('x-wled-source') === 'mock';
      if (d?.info) this.#applyInfo(d.info);
      // Re-tester APRÈS l'await : une commande (drag, POST, scène) partie pendant
      // le GET rend cette réponse périmée — l'appliquer ferait « sauter » l'UI en
      // arrière (slider sous le doigt, scène qui revient). Garde essentielle.
      if (d?.state && !this.#busy() && !this.#sending && this.#cmdSeq === seq)
        this.#applyState(d.state);
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
    this.loadMeta();
    this.refresh();
    this.#timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh();
    }, POLL_MS);
    this.#vis = () => {
      if (document.visibilityState === 'visible') this.refresh();
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

  // ─── Commandes (optimistes + POST sérialisés) ────────
  // UN SEUL POST en vol à la fois. Les commandes émises pendant ce temps
  // FUSIONNENT dans un payload d'attente (dernière valeur gagne, par segment) :
  //   - un drag de slider ne produit plus une rafale de requêtes qui sature
  //     l'ESP32 (cadence naturelle = 1 requête par aller-retour réseau) ;
  //   - les réponses ne reviennent plus dans le désordre → fini l'état périmé
  //     qui écrase le dernier clic quand on enchaîne les commandes.
  #inflight = false;
  #pendingBody: Record<string, unknown> | null = null;

  /** File de commandes active ? (gèle refresh() → pas de GET périmé intercalé) */
  get #sending(): boolean {
    return this.#inflight || this.#pendingBody !== null;
  }

  /** Fusion « dernière valeur définie gagne ». Les clés `undefined` sont
   *  ignorées : sinon un ordre `{on: undefined, bri}` (setSegBri quand bri>0
   *  n'ajoute pas on) écraserait un `on: true` déjà en attente et l'allumage
   *  serait perdu. JSON.stringify supprime déjà les undefined à l'envoi. */
  #assignDefined(dst: Record<string, unknown>, src: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(src)) if (v !== undefined) dst[k] = v;
  }
  #mergeBody(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      if (k === 'seg' && Array.isArray(v) && Array.isArray(dst.seg)) {
        const merged = dst.seg as Record<string, unknown>[];
        const byId = new Map(merged.map((s) => [s.id, s]));
        for (const s of v as Record<string, unknown>[]) {
          const ex = byId.get(s.id);
          if (ex) this.#assignDefined(ex, s);
          else merged.push(s);
        }
      } else {
        dst[k] = v;
      }
    }
    return dst;
  }

  async #post(partial: object): Promise<void> {
    // Toute commande (scène, effet, on/off, drag) est une écriture : bumper la
    // séquence invalide un GET de refresh() déjà en vol, même si le POST se
    // termine avant le retour du GET (sinon l'ancien état écraserait la commande).
    this.#cmdSeq++;
    if (this.#inflight) {
      // Un POST est déjà en route : on fusionne, il partira juste après.
      this.#pendingBody = this.#mergeBody(this.#pendingBody ?? {}, {
        ...(partial as Record<string, unknown>)
      });
      return;
    }
    this.#inflight = true;
    let body: Record<string, unknown> | null = { ...(partial as Record<string, unknown>) };
    let lastFailed = false;
    try {
      while (body) {
        lastFailed = false;
        try {
          const res = await fetch('/api/wled/json/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // v:true → le vrai WLED renvoie l'état complet (sinon {success:true}).
            body: JSON.stringify({ ...body, v: true }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const d = await res.json().catch(() => null);
          // Réconciliation UNIQUEMENT si plus rien n'attend (la réponse reflète
          // alors le dernier ordre) et hors drag (l'optimiste fait foi).
          if (
            this.#pendingBody === null &&
            !this.#busy() &&
            d &&
            typeof d === 'object' &&
            ('seg' in d || 'bri' in d || 'on' in d)
          ) {
            this.#applyState(d as Record<string, unknown>);
          }
          this.connected = true;
          this.lastError = null;
          this.lastUpdate = new Date();
        } catch (e) {
          lastFailed = true;
          this.lastError = e instanceof Error ? e.message : 'erreur';
        }
        body = this.#pendingBody;
        this.#pendingBody = null;
        // Petit répit entre deux ordres enchaînés — l'ESP32 n'aime pas le tir en rafale.
        if (body) await new Promise((r) => setTimeout(r, 60));
      }
    } finally {
      this.#inflight = false;
    }
    if (lastFailed && !this.#busy()) this.refresh(); // resync si le DERNIER ordre a échoué
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
  /** Bascule Ensemble (1 segment continu) ↔ Par ligne (un segment par entrée
   *  de LINES). Layout calculé depuis la longueur RÉELLE du module (this.total),
   *  jamais en dur ; `stop: 0` = suppression du segment (sémantique WLED).
   *  ⚠️ Le firmware CRÉE tout segment inconnu avec SES défauts (allumé, blanc,
   *  luminosité max) : on fournit l'état HÉRITÉ du segment maître pour que les
   *  lignes naissent à l'identique de l'existant — jamais « armées » à l'insu. */
  async setScope(s: WledScope): Promise<void> {
    const total = this.total || SEG_SPLIT;
    const base = this.segments[0];
    const inherit = base
      ? {
          on: base.on,
          bri: base.bri,
          col: this.#colPayload(base.col, base.white),
          fx: base.fx,
          sx: base.sx,
          ix: base.ix,
          pal: base.pal
        }
      : {};
    const seg =
      s === 'perLine' && this.canSplit
        ? LINES.map((l, i) => ({
            id: i,
            start: l.start,
            stop: l.stop ?? total,
            n: l.n,
            ...inherit
          }))
        : [
            { id: 0, start: 0, stop: total, n: 'Terrasse', ...inherit },
            ...LINES.slice(1).map((_, i) => ({ id: i + 1, stop: 0 }))
          ];
    // Reflet OPTIMISTE de la topologie : une commande enchaînée juste derrière
    // (ambiance, couleur) itère this.segments — sans ça elle raterait les
    // lignes qui n'existent que dans la réponse à venir. L'écho réconcilie.
    if (base) {
      const live = seg as { id: number; start?: number; stop: number; n?: string }[];
      this.segments = live
        .filter((g) => g.stop > 0)
        .map((g) => ({
          ...base,
          id: g.id,
          name: g.n ?? base.name,
          len: g.stop - (g.start ?? 0),
          col: [...base.col] as RGB
        }));
    }
    await this.#post({ seg });
  }
  /** Luminosité maître. bri=0 NE coupe PAS l'alimentation (le slider reste pilotable). */
  async setBri(v: number): Promise<void> {
    this.#touch();
    const b = clamp(v);
    this.bri = b;
    if (b > 0) this.on = true;
    await this.#post({ bri: b }); // pas de on:false couplé à bri:0
  }

  // Segment
  async setSegOn(id: number, on: boolean): Promise<void> {
    const s = this.#seg(id);
    if (s) s.on = on;
    await this.#post({ seg: [{ id, on }] });
  }
  async setSegBri(id: number, v: number): Promise<void> {
    this.#touch();
    const b = clamp(v);
    const s = this.#seg(id);
    if (s) {
      s.bri = b;
      if (b > 0) s.on = true;
    }
    await this.#post({ seg: [{ id, on: b > 0 ? true : undefined, bri: b }] });
  }
  async setSegColor(id: number, rgb: RGB): Promise<void> {
    this.#touch();
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
    this.#touch();
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
    this.#touch();
    const v = clamp(sx);
    const s = this.#seg(id);
    if (s) s.sx = v;
    await this.#post({ seg: [{ id, sx: v }] });
  }
  async setSegIntensity(id: number, ix: number): Promise<void> {
    this.#touch();
    const v = clamp(ix);
    const s = this.#seg(id);
    if (s) s.ix = v;
    await this.#post({ seg: [{ id, ix: v }] });
  }

  // Le rendu du mode Musique (couleurs de pochette + effet du style) est
  // appliqué CÔTÉ SERVEUR (src/lib/server/wled/music-mode.ts) : le client
  // n'envoie que l'extraction de pochette avec son heartbeat.

  /** Applique une ambiance aux segments RÉELS (jamais d'id fantôme). */
  async applyAmbiance(key: string): Promise<void> {
    const a = WLED_AMBIANCES.find((x) => x.key === key);
    if (!a) return;
    if (a.off) {
      await this.setOn(false);
      return;
    }
    // Effet : repli sur Solid si le nom n'existe pas sur ce firmware (mieux un
    // rendu fixe propre que l'effet précédent qui « colle »). Palette : les
    // ambiances sans palette explicite reviennent à Default (0) — sinon la
    // palette de l'ambiance PRÉCÉDENTE (ex. Party) contamine la nouvelle.
    const wanted = resolveByName(this.effects, a.fx);
    const fxIdx = a.fx ? (wanted >= 0 ? wanted : this.solidFx) : -1;
    const palIdx = a.pal ? Math.max(0, resolveByName(this.palettes, a.pal)) : 0;

    // Reflet optimiste local + payload depuis la MÊME source (segments réels).
    for (const s of this.segments) {
      s.on = true;
      if (a.bri !== undefined) s.bri = clamp(a.bri);
      if (a.col) s.col = a.col;
      if (a.white !== undefined) s.white = clamp(a.white);
      if (fxIdx >= 0) s.fx = fxIdx;
      if (palIdx >= 0) s.pal = palIdx;
      if (a.sx !== undefined) s.sx = clamp(a.sx);
      if (a.ix !== undefined) s.ix = clamp(a.ix);
    }
    this.on = true;

    const seg = this.segments.map((s) => {
      const o: Record<string, unknown> = { id: s.id, on: true };
      if (a.bri !== undefined) o.bri = clamp(a.bri);
      if (a.col || a.white !== undefined) {
        const rgb = a.col ?? s.col;
        const w = a.white ?? s.white;
        o.col = this.#colPayload(rgb, w);
      }
      if (fxIdx >= 0) o.fx = fxIdx;
      if (palIdx >= 0) o.pal = palIdx;
      if (a.sx !== undefined) o.sx = clamp(a.sx);
      if (a.ix !== undefined) o.ix = clamp(a.ix);
      return o;
    });
    const body: Record<string, unknown> = { on: true };
    if (a.bri !== undefined) body.bri = clamp(a.bri);
    if (seg.length) body.seg = seg;
    await this.#post(body);
  }
}

export const wled = new WledStore();
