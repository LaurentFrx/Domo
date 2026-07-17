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
  style: string;
}

/** Événement poussé aux abonnés SSE (champs présents = champs qui changent). */
export interface LiveEvent {
  enabled?: boolean;
  style?: string;
  key?: string | null;
  playing?: boolean;
  analyzing?: boolean;
  level?: number;
  peak?: number;
}

function loadState(): MusicModeState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<MusicModeState>;
    return {
      enabled: raw.enabled === true,
      style: WLED_MUSIC_STYLES.some((s) => s.key === raw.style) ? (raw.style as string) : 'ambiance'
    };
  } catch {
    return { enabled: false, style: 'ambiance' };
  }
}

const state: MusicModeState = loadState();
/** Dernier `on` connu du ruban (proxy + rendus). Défaut optimiste. */
let moduleOn = true;
/** Repli statique DIFFÉRÉ : la sortie du mode a trouvé le ruban éteint — le
 *  repli sera rejoué au prochain rallumage (sinon l'effet audio-réactif reste
 *  gravé dans le module : rallumage = ruban allumé mais noir/figé). */
let pendingFallback = false;

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
  return { ...state };
}

export function isMusicEnabled(): boolean {
  return state.enabled;
}

export function isReactiveStyle(): boolean {
  return musicStyleDef(state.style).fx !== null;
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
    pendingFallback = false; // le rendu musique remplace tout repli en attente
    console.log('[wled/mode] ruban rallumé — rendu différé rejoué');
    void applyRender(playingProvider());
  } else if (!was && on && pendingFallback) {
    if (opts.postsState) {
      // Le rallumage vient d'une commande qui POSE déjà son état (scène,
      // couleur…) : le repli est superflu et ferait la course avec elle.
      pendingFallback = false;
      console.log('[wled/mode] repli différé désarmé (état posé par la commande)');
    } else {
      console.log('[wled/mode] ruban rallumé — repli statique différé rejoué');
      void applyStaticFallback();
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
      state?: { on?: boolean; seg?: { id?: number; stop?: number }[] };
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

    const def = musicStyleDef(state.style);
    const reactive = def.fx !== null && !opts.forceAmbiance;
    // Lecture → effet réactif du style ; pause (ou style Ambiance) → fondu
    // doux multicolore lent. JAMAIS de Solid : le mode reste vivant et coloré.
    const paused = !playing;
    const fxIdx = resolveByName(effects, reactive && !paused ? (def.fx ?? MUSIC_FX) : MUSIC_FX);
    const palIdx = Math.max(0, resolveByName(palettes, def.pal));
    const colPayload = MODE_SLOTS.map((x) => [x[0], x[1], x[2], 0]);

    // `on` par segment : JAMAIS envoyé sur un rendu automatique (une ligne
    // éteinte volontairement — bras du store repliés — doit le RESTER) ; seul
    // le geste utilisateur (powerOn) allume ruban ET lignes.
    await modulePostState({
      ...(opts.powerOn ? { on: true } : {}),
      seg: segs.map((s) => ({
        id: s.id ?? 0,
        ...(opts.powerOn ? { on: true } : {}),
        col: colPayload,
        ...(fxIdx >= 0 ? { fx: fxIdx } : {}),
        pal: palIdx,
        sx: paused ? 30 : (def.sx ?? 50),
        ix: paused ? 128 : (def.ix ?? 150)
      }))
    });
    if (opts.powerOn) moduleOn = true;
    console.log(
      `[wled/mode] rendu appliqué : fx=${fxIdx >= 0 ? effects[fxIdx] : '(inchangé)'} ` +
        `pal=${palIdx >= 0 ? (palettes[palIdx] ?? palIdx) : palIdx} paused=${paused} ` +
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
 */
export function applyStaticFallback(): Promise<void> {
  const run = async () => {
    const { data } = await moduleGet('');
    const d = data as {
      state?: { on?: boolean; seg?: { id?: number; stop?: number }[] };
      effects?: string[];
    };
    if (d.state?.on !== true) {
      // Ruban éteint : on ne rallume pas, mais l'effet audio-réactif reste
      // gravé dans le module → repli DIFFÉRÉ, rejoué par noteModuleOn au
      // prochain rallumage (app WLED native comprise, via le poll du proxy).
      pendingFallback = true;
      console.log('[wled/mode] repli statique différé : ruban éteint');
      return;
    }
    const segs = (d.state?.seg ?? []).filter((s) => (s.stop ?? 0) > 0);
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
    pendingFallback = false;
    console.log('[wled/mode] repli statique appliqué (Solid blanc chaud)');
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
  setTimeout(() => {
    if (state.enabled) {
      console.log('[wled/mode] réconciliation post-restart : rendu reposé');
      void applyRender(playingProvider());
    }
  }, 10_000);
  // Poll de fond 60 s : détecte un (r)allumage fait HORS Domo (app WLED
  // native, coupure de courant) même sans musique en cours — les rendus/replis
  // différés sont rejoués. Le tick du streamer garde son refresh 10 s en session.
  setInterval(() => {
    void moduleGet('state')
      .then(({ data }) => noteModuleOn((data as { on?: unknown })?.on === true))
      .catch(() => undefined); // module injoignable : on garde le dernier connu
  }, 60_000);
}

// ─── Mutations (POST /api/wled/music/mode) ───────────────────────

export interface ModePatch {
  enabled?: boolean;
  style?: string;
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
  if (Object.keys(ev).length) {
    persist();
    broadcastLive(ev);
    if (state.enabled && (ev.enabled || ev.style)) {
      pendingFallback = false; // le rendu musique remplace tout repli en attente
      void applyRender(playingNow, { powerOn: opts.userGesture === true });
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
