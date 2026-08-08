/**
 * Mode Musique de l'éclairage terrasse — ÉTAT PARTAGÉ côté serveur.
 *
 * `enabled` + `style` décrivent UN ruban physique : ils vivent ici (persistés
 * dans data/, survivent au restart), plus jamais en localStorage par appareil.
 * Tous les clients voient et pilotent le MÊME état ; le rendu musique est
 * appliqué au module PAR LE SERVEUR — le client ne pilote plus ce rendu.
 *
 * CONTRAT COULEURS (décision Laurent) : les effets musicaux ont LEURS PROPRES
 * COULEURS — la palette multicolore dédiée du style (music-styles.ts). Jamais
 * de monochrome, jamais de couleurs de pochette. La pause reste multicolore
 * (fondu lent), pas de Solid.
 *
 * Le module diffuse aussi les événements « live » (hub SSE consommé par
 * /api/wled/music/live) : changements d'état + niveau sonore 12,5 Hz pendant
 * la lecture (poussé par le tick du streamer).
 *
 * Règle d'or : le mode musique ne RALLUME jamais un ruban éteint —
 * l'interrupteur appartient à l'utilisateur (sauf geste explicite : powerOn).
 */

import { readFileSync, writeFile } from 'node:fs';
import path from 'node:path';
import {
  MUSIC_FX,
  musicStyleDef,
  resolveByName,
  WLED_MUSIC_STYLES,
  type RGB
} from '$lib/wled/music-styles';
import { moduleGet, modulePostState } from './module-client';

const STATE_PATH = path.join('data', 'wled-music-mode.json');

export interface MusicModeState {
  enabled: boolean;
  /** Style des lignes qui n'ont pas de réglage propre (cf. `lines`). */
  style: string;
  /**
   * Réglage PAR LIGNE : id de segment → clé de style, ou `null` = cette ligne
   * NE SUIT PAS la musique (elle garde ce que l'utilisateur y a posé).
   * Une ligne absente de l'objet suit `style` — c'est le défaut, et le
   * comportement d'avant l'introduction du réglage par ligne.
   *
   * Pourquoi par ligne : la terrasse porte deux rubans de nature différente
   * (« SàM d'Été » éclaire la table, « Store » borde les bras du store banne).
   * Faire danser le store pendant que la table reste en blanc chaud est l'usage
   * courant — l'ancien état global l'interdisait.
   */
  lines: Record<string, string | null>;
}

/** Événement poussé aux abonnés SSE (champs présents = champs qui changent). */
export interface LiveEvent {
  enabled?: boolean;
  style?: string;
  /** Réglage par ligne — diffusé ENTIER (un diff partiel serait ambigu : une
   *  clé absente veut déjà dire « suit le style global »). */
  lines?: Record<string, string | null>;
  key?: string | null;
  playing?: boolean;
  analyzing?: boolean;
  level?: number;
  peak?: number;
}

/** Ne garde que les entrées interprétables (style connu, ou null). */
function sanitizeLines(raw: unknown): Record<string, string | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | null> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(id)) continue;
    if (v === null) out[id] = null;
    else if (typeof v === 'string' && WLED_MUSIC_STYLES.some((s) => s.key === v)) out[id] = v;
  }
  return out;
}

function loadState(): MusicModeState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<MusicModeState>;
    return {
      enabled: raw.enabled === true,
      style: WLED_MUSIC_STYLES.some((s) => s.key === raw.style)
        ? (raw.style as string)
        : 'ambiance',
      lines: sanitizeLines(raw.lines)
    };
  } catch {
    return { enabled: false, style: 'ambiance', lines: {} };
  }
}

const state: MusicModeState = loadState();
/** Dernier `on` connu du ruban (proxy + rendus). Défaut optimiste. */
let moduleOn = true;
/**
 * Repli statique DIFFÉRÉ : la sortie du mode a trouvé le ruban éteint — le
 * repli sera rejoué au prochain rallumage (sinon l'effet audio-réactif reste
 * gravé dans le module : rallumage = ruban allumé mais noir/figé).
 *
 * `'all'` = sortie complète du mode ; un tableau = seulement CES lignes (une
 * ligne qu'on vient de retirer de la musique pendant que les autres dansent).
 */
let pendingFallback: 'all' | number[] | null = null;

function persist(): void {
  writeFile(STATE_PATH, JSON.stringify(state), () => undefined); // best-effort
}

// ─── Hub SSE ─────────────────────────────────────────────────────

type LiveListener = (e: LiveEvent) => void;
const listeners = new Set<LiveListener>();

export function subscribeLive(fn: LiveListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcastLive(e: LiveEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* abonné mort — retiré par son cancel() */
    }
  }
}

// ─── État ────────────────────────────────────────────────────────

export function musicModeState(): MusicModeState {
  return { ...state, lines: { ...state.lines } };
}

export function isMusicEnabled(): boolean {
  return state.enabled;
}

/** Style effectif d'une ligne : son réglage propre, sinon le style global.
 *  `null` = la ligne ne suit pas la musique. */
export function lineStyle(segId: number): string | null {
  const own = state.lines[String(segId)];
  return own === undefined ? state.style : own;
}

/**
 * Segments vus au dernier rendu. `state.lines` ne liste que les lignes RÉGLÉES
 * explicitement : sans la liste réelle, impossible de savoir s'il reste une
 * ligne « par défaut » (donc soumise au style global). Mémorisé ici plutôt que
 * redemandé au module — `isReactiveStyle()` est appelé à chaque trame (25 Hz).
 */
let lastSegIds: number[] = [];

/**
 * Faut-il streamer de l'audio ? OUI dès qu'UNE ligne suit un style réactif.
 *
 * Sur l'état global d'avant, la question se réglait en un mot. Avec le réglage
 * par ligne, un ruban dont les lignes participantes sont toutes en « Ambiance »
 * (ou dont aucune ne participe) n'a aucun besoin du flux UDP : le streamer se
 * tait au lieu d'arroser le module pour rien.
 */
export function isReactiveStyle(): boolean {
  // Avant le premier rendu, on ne connaît aucun segment : se fier au global.
  const ids = lastSegIds.length ? lastSegIds : null;
  if (!ids) return musicStyleDef(state.style).fx !== null;
  return ids.some((id) => {
    const k = lineStyle(id);
    return k !== null && musicStyleDef(k).fx !== null;
  });
}

/** Le ruban est-il allumé, au dernier signal connu ? (suspend le stream UDP) */
export function isModuleOn(): boolean {
  return moduleOn;
}

/** Fournisseur de l'état de lecture courant — enregistré par sound-streamer
 *  (évite l'import circulaire music-mode → sound-streamer). */
let playingProvider: () => boolean = () => false;
export function registerPlayingProvider(fn: () => boolean): void {
  playingProvider = fn;
}

/** À appeler à chaque signal d'alimentation du ruban (POST proxy, rendus,
 *  rafraîchissement du tick). Transition éteint→allumé pendant que le mode est
 *  actif → le rendu différé est REJOUÉ (c'est le « rendu différé » promis). */
export function noteModuleOn(on: boolean, opts: { postsState?: boolean } = {}): void {
  const was = moduleOn;
  moduleOn = on;
  if (!was && on && state.enabled) {
    // Le rendu musique va repeindre les lignes qui suivent ; celles qu'on
    // avait retirées du mode, elles, attendent toujours leur repli — il ne
    // faut donc PAS l'oublier ici (il ne concerne pas les mêmes lignes).
    const orphans = Array.isArray(pendingFallback) ? pendingFallback : null;
    pendingFallback = null;
    console.log('[wled/mode] ruban rallumé — rendu différé rejoué');
    void applyRender(playingProvider());
    if (orphans?.length) void applyStaticFallback(orphans);
  } else if (!was && on && pendingFallback) {
    if (opts.postsState) {
      // Le rallumage vient d'une commande qui POSE déjà son état (scène,
      // couleur…) : le repli est superflu et ferait la course avec elle.
      pendingFallback = null;
      console.log('[wled/mode] repli différé désarmé (état posé par la commande)');
    } else {
      const only = Array.isArray(pendingFallback) ? pendingFallback : undefined;
      console.log('[wled/mode] ruban rallumé — repli statique différé rejoué');
      void applyStaticFallback(only);
    }
  }
}

// ─── Rendu (porté du client — ex-applyMusicColors/setMusicPaused) ───

let renderChain: Promise<void> = Promise.resolve();

interface RenderOpts {
  /** Rendu « ambiance » même si le style est réactif (repli analyse échouée). */
  forceAmbiance?: boolean;
  /** GESTE UTILISATEUR (chip Musique, changement de style) : le rendu ALLUME
   *  le ruban (`on:true` racine). Les rendus AUTOMATIQUES (beats, couleurs,
   *  pause/lecture, replis) ne rallument jamais — ne pas surprendre la nuit. */
  powerOn?: boolean;
}

/** Couleurs PROPRES au mode musique : ambre doux en primaire (pour les rares
 *  effets qui piochent col[0]) et FOND NOIR — indispensable à la lisibilité
 *  des effets réactifs (fond vif = ruban plein, courbe volume→lumière plate,
 *  mesuré sur le ruban). Le rendu multicolore vient de la PALETTE du style. */
const MODE_SLOTS: RGB[] = [
  [255, 170, 60],
  [0, 0, 0],
  [0, 0, 0]
];

/**
 * Applique le rendu musique au ruban : effet du style + SA palette
 * multicolore. Lecture → effet réactif ; pause → fondu doux (MUSIC_FX), même
 * palette — TOUJOURS multicolore, jamais de Solid. Séquentialisé. Chaque
 * sortie précoce est logguée.
 */
export function applyRender(playing: boolean, opts: RenderOpts = {}): Promise<void> {
  const run = async () => {
    if (!state.enabled) return; // désactivation entre-temps : rien à faire

    const { data } = await moduleGet('');
    const d = data as {
      state?: { on?: boolean; bri?: number; seg?: { id?: number; stop?: number; n?: string }[] };
      effects?: string[];
      palettes?: string[];
    };
    const effects = d.effects ?? [];
    const palettes = d.palettes ?? [];
    const segs = (d.state?.seg ?? []).filter((s) => (s.stop ?? 0) > 0);
    if (!segs.length) {
      console.log('[wled/mode] rendu différé : aucun segment');
      return;
    }
    moduleOn = d.state?.on === true;
    if (!moduleOn && !opts.powerOn) {
      console.log('[wled/mode] rendu différé : ruban éteint');
      return; // règle d'or : un rendu AUTOMATIQUE ne rallume jamais
    }

    lastSegIds = segs.map((s) => s.id ?? 0);
    const paused = !playing;
    const colPayload = MODE_SLOTS.map((x) => [x[0], x[1], x[2], 0]);

    // Le rendu se calcule LIGNE PAR LIGNE : chacune a son style (ou aucun).
    // Une ligne qui ne suit pas la musique n'est pas dans le payload du tout —
    // le module n'y touche donc pas, et elle garde ce que l'utilisateur y a
    // posé (blanc chaud de la table, par exemple) pendant que l'autre danse.
    const payload: Record<string, unknown>[] = [];
    const rendered: string[] = [];
    for (const s of segs) {
      const id = s.id ?? 0;
      const key = lineStyle(id);
      if (key === null) continue; // ligne hors musique : intouchée
      const def = musicStyleDef(key);
      const reactive = def.fx !== null && !opts.forceAmbiance;
      // Lecture → effet réactif du style ; pause (ou style Ambiance) → fondu
      // doux multicolore lent. JAMAIS de Solid : le mode reste vivant et coloré.
      const fxIdx = resolveByName(effects, reactive && !paused ? (def.fx ?? MUSIC_FX) : MUSIC_FX);
      const palIdx = Math.max(0, resolveByName(palettes, def.pal));
      payload.push({
        id,
        // `on` par segment : JAMAIS envoyé sur un rendu automatique (une ligne
        // éteinte volontairement — bras du store repliés — doit le RESTER) ;
        // seul le geste utilisateur (powerOn) allume ruban ET lignes.
        ...(opts.powerOn ? { on: true } : {}),
        col: colPayload,
        ...(fxIdx >= 0 ? { fx: fxIdx } : {}),
        pal: palIdx,
        sx: paused ? 30 : (def.sx ?? 50),
        ix: paused ? 128 : (def.ix ?? 150)
      });
      rendered.push(`${s.n ?? id}=${fxIdx >= 0 ? effects[fxIdx] : '(inchangé)'}`);
    }

    if (!payload.length) {
      console.log('[wled/mode] rendu sans objet : aucune ligne ne suit la musique');
      return;
    }

    // Plancher de luminosité SUR LE GESTE seulement : « voir la musique » à
    // 16 % de luminosité résiduelle est invisible en extérieur — le geste
    // exprime l'intention, on lui donne au moins ~40 %. Un rendu automatique,
    // lui, ne touche jamais bri (ne pas surprendre la nuit).
    const MIN_POWER_ON_BRI = 100;
    const curBri = typeof d.state?.bri === 'number' ? d.state.bri : 255;
    await modulePostState({
      ...(opts.powerOn
        ? { on: true, ...(curBri < MIN_POWER_ON_BRI ? { bri: MIN_POWER_ON_BRI } : {}) }
        : {}),
      seg: payload
    });
    if (opts.powerOn) moduleOn = true;
    console.log(
      `[wled/mode] rendu appliqué : ${rendered.join(' · ')} paused=${paused} ` +
        `on=${moduleOn} powerOn=${opts.powerOn === true}`
    );
  };
  renderChain = renderChain.then(run).catch((e) => {
    console.error('[wled/mode] rendu échoué:', (e as Error).message);
  });
  return renderChain;
}

/**
 * État statique PROPRE à la désactivation du mode (ou péremption) : fx Solid,
 * couleur dominante, fond non noir, réglages neutres. Le ruban ne doit JAMAIS
 * rester sur un effet audio-réactif sans stream (= allumé mais noir).
 *
 * @param onlyIds ne replier QUE ces lignes (celles qu'on vient de retirer de
 *   la musique). Sans argument : toutes — sortie complète du mode.
 */
export function applyStaticFallback(onlyIds?: number[]): Promise<void> {
  const run = async () => {
    const { data } = await moduleGet('');
    const d = data as {
      state?: { on?: boolean; seg?: { id?: number; stop?: number; n?: string }[] };
      effects?: string[];
    };
    if (d.state?.on !== true) {
      // Ruban éteint : on ne rallume pas, mais l'effet audio-réactif reste
      // gravé dans le module → repli DIFFÉRÉ, rejoué par noteModuleOn au
      // prochain rallumage (app WLED native comprise, via le poll du proxy).
      // Un repli global en attente absorbe un repli ciblé (il le contient).
      if (pendingFallback !== 'all') {
        pendingFallback = onlyIds
          ? [...new Set([...(Array.isArray(pendingFallback) ? pendingFallback : []), ...onlyIds])]
          : 'all';
      }
      console.log('[wled/mode] repli statique différé : ruban éteint');
      return;
    }
    let segs = (d.state?.seg ?? []).filter((s) => (s.stop ?? 0) > 0);
    if (onlyIds) segs = segs.filter((s) => onlyIds.includes(s.id ?? 0));
    if (!segs.length) return;
    const solid = (d.effects ?? []).indexOf('Solid');
    // Sortie du mode : on rend un état STATIQUE chaleureux (blanc chaud, fond
    // restauré) — plus d'effet audio orphelin, et l'utilisateur reprend la
    // main sur SES couleurs via le picker/les ambiances.
    const warm: RGB[] = [
      [255, 190, 120],
      [255, 190, 120],
      [255, 190, 120]
    ];
    const colPayload = warm.map((x) => [x[0], x[1], x[2], 60]);
    await modulePostState({
      seg: segs.map((s) => ({
        id: s.id ?? 0,
        col: colPayload,
        ...(solid >= 0 ? { fx: solid } : {}),
        pal: 0,
        sx: 128,
        ix: 128
      }))
    });
    if (!onlyIds) pendingFallback = null;
    console.log(
      `[wled/mode] repli statique appliqué (Solid blanc chaud)${
        onlyIds ? ` — lignes ${segs.map((s) => s.n ?? s.id).join(', ')}` : ''
      }`
    );
  };
  renderChain = renderChain.then(run).catch((e) => {
    console.error('[wled/mode] repli statique échoué:', (e as Error).message);
  });
  return renderChain;
}

// ─── Réconciliation post-restart + poll de fond ──────────────────
// (garde globalThis : le HMR de dev ré-évalue ce module — jamais deux timers)

const G = globalThis as { __wledModeTimers?: boolean };
if (!G.__wledModeTimers) {
  G.__wledModeTimers = true;
  console.log(`[wled/mode] timers de fond armés (enabled=${state.enabled})`);
  // Restart du serveur pendant une écoute : session/heartbeats perdus mais
  // `enabled` persisté → sans ça, l'effet audio-réactif resterait orphelin
  // (ruban allumé mais noir). On repose un rendu : pause si rien ne joue,
  // réactif si les heartbeats ont déjà repris. Délai : laisser le tunnel monter.
  // unref() : ces timers de fond ne doivent JAMAIS retenir le process à l'arrêt
  // (SIGTERM) — sans ça, l'event loop ne se vide pas et systemd finit en SIGKILL.
  setTimeout(() => {
    if (state.enabled) {
      console.log('[wled/mode] réconciliation post-restart : rendu reposé');
      void applyRender(playingProvider());
    }
  }, 10_000).unref();
  // Poll de fond 60 s : détecte un (r)allumage fait HORS Domo (app WLED
  // native, coupure de courant) même sans musique en cours — les rendus/replis
  // différés sont rejoués. Le tick du streamer garde son refresh 10 s en session.
  setInterval(() => {
    void moduleGet('state')
      .then(({ data }) => noteModuleOn((data as { on?: unknown })?.on === true))
      .catch(() => undefined); // module injoignable : on garde le dernier connu
  }, 60_000).unref();
}

// ─── Mutations (POST /api/wled/music/mode) ───────────────────────

export interface ModePatch {
  enabled?: boolean;
  style?: string;
  /** Réglage par ligne — REMPLACE l'objet entier (cf. MusicModeState.lines). */
  lines?: Record<string, string | null>;
}

/** Lignes qui suivent la musique, parmi celles vues au dernier rendu. */
function participants(): number[] {
  return lastSegIds.filter((id) => lineStyle(id) !== null);
}

/**
 * Met à jour l'état partagé, persiste, diffuse aux abonnés, et applique le
 * rendu au ruban quand c'est pertinent. `playingNow` : état de lecture courant
 * (fourni par l'appelant — l'endpoint le lit auprès du streamer).
 * `opts.userGesture` : la mutation vient d'un GESTE (chip Musique, changement
 * de style via POST /mode) → le rendu ALLUME le ruban (powerOn). Les mutations
 * automatiques ne rallument jamais.
 */
export async function setMode(
  patch: ModePatch,
  playingNow: boolean,
  opts: { userGesture?: boolean; quiet?: boolean } = {}
): Promise<MusicModeState> {
  const ev: LiveEvent = {};
  // Qui suivait la musique AVANT ce patch ? Une ligne qu'on en retire garde
  // sinon l'effet audio-réactif gravé dans le module — allumée mais noire.
  const before = state.enabled ? participants() : [];

  if (typeof patch.enabled === 'boolean' && patch.enabled !== state.enabled) {
    state.enabled = patch.enabled;
    ev.enabled = state.enabled;
  }
  if (typeof patch.style === 'string' && WLED_MUSIC_STYLES.some((s) => s.key === patch.style)) {
    if (patch.style !== state.style) {
      state.style = patch.style;
      ev.style = state.style;
    }
  }
  if (patch.lines) {
    const next = sanitizeLines(patch.lines);
    if (JSON.stringify(next) !== JSON.stringify(state.lines)) {
      state.lines = next;
      ev.lines = { ...next };
    }
  }
  if (Object.keys(ev).length) {
    persist();
    broadcastLive(ev);
    // Lignes qui SORTENT du mode alors qu'il reste actif : leur rendre un état
    // statique propre, sans toucher à celles qui continuent de danser.
    const orphans = state.enabled ? before.filter((id) => lineStyle(id) === null) : [];
    if (state.enabled && (ev.enabled || ev.style || ev.lines)) {
      pendingFallback = null; // le rendu musique remplace tout repli en attente
      void applyRender(playingNow, { powerOn: opts.userGesture === true });
      if (orphans.length) void applyStaticFallback(orphans);
    } else if (ev.enabled === false && !opts.quiet) {
      // Désactivation : ne JAMAIS laisser le ruban échoué sur un effet
      // audio-réactif sans stream (allumé mais noir) — état statique propre.
      // `quiet` : la désactivation ACCOMPAGNE une commande manuelle (scène,
      // couleur, effet) qui pose son propre état — un repli en parallèle
      // ferait la course avec elle et l'écraserait.
      void applyStaticFallback();
    } else if (ev.enabled === false && opts.quiet) {
      console.log('[wled/mode] désactivation silencieuse (commande manuelle en cours)');
    }
  }
  return musicModeState();
}
