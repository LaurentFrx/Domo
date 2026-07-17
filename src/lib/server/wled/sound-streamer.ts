/**
 * Streamer sound-sync WLED — rejoue la timeline spectrale d'un morceau,
 * calée sur la position du lecteur, vers le module (UDP, format audioSyncPacket
 * V2 44 octets, header "00002" — validé de bout en bout sur le firmware 16.0.1).
 *
 * Chemin réseau : VPS → Tailscale → RPi4 (relais socat `wled-udp-relay`,
 * conteneur --restart unless-stopped) → UNICAST 192.168.1.44:11988. Le
 * multicast 239.0.0.1 natif du protocole ne traverse PAS la Livebox
 * (ethernet→Wi-Fi) — l'unicast atteint la même socket (bind ANY:port).
 *
 * Synchronisation : l'appareil QUI JOUE remonte {position, playing} par
 * heartbeat ; le serveur EXTRAPOLE entre deux heartbeats (l'app iOS en
 * arrière-plan continue la musique mais ses timers JS gèlent). Failsafe :
 * sans heartbeat depuis STALE_MS, on fige — jamais de stream fantôme.
 *
 * ANTI-DÉTOURNEMENT : un appareil qui a simplement une piste CHARGÉE en pause
 * ne peut pas écraser la session d'un appareil qui JOUE. Un heartbeat d'une
 * autre piste n'est accepté que s'il joue (nouvelle lecture volontaire) ou si
 * la session est absente/périmée. Il n'y a plus de {stop:true} client :
 * l'arrêt découle du mode global (enabled=false) ou de la péremption.
 *
 * Le tick alimente aussi le hub SSE (music-mode) : niveau sonore à 12,5 Hz
 * (une trame sur deux) pour que la barre de la carte danse sur TOUS les
 * appareils.
 */

import dgram from 'node:dgram';
import { env } from '$env/dynamic/private';
import { analyzeTrack, cachedTimeline, frameAt, type Timeline } from './audio-analysis';
import {
  applyRender,
  broadcastLive,
  isModuleOn,
  isMusicEnabled,
  isReactiveStyle,
  noteModuleOn,
  registerPlayingProvider
} from './music-mode';
import { moduleGet } from './module-client';

const PACKET_HDR = '00002\0';
const SEND_MS = 40; // 25 fps
const STALE_MS = 45_000;
/** Relais UDP sur le RPi4 (Tailscale). Surchargable via env. */
function relayTarget(): { host: string; port: number } | null {
  const raw = env.WLED_SOUND_RELAY || '100.126.201.4:11988';
  if (raw === 'off') return null;
  const [host, port] = raw.split(':');
  return { host, port: Number(port) || 11988 };
}

interface Session {
  key: string;
  timeline: Timeline | null; // null : piste en analyse ou style ambiance
  /** Position (ms) au moment du dernier heartbeat. */
  basePosMs: number;
  baseAt: number;
  playing: boolean;
  lastHeartbeat: number;
}

let session: Session | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let socket: dgram.Socket | null = null;
/** Piste en cours d'analyse (clé) — pour le retour `analyzing` de l'API. */
let analyzing: string | null = null;
/** Analyses échouées récentes (clé → horodatage) : évite de re-tenter en
 *  boucle à chaque heartbeat un fichier réellement illisible. */
const failedAnalysis = new Map<string, number>();
const FAILED_RETRY_MS = 60_000;
/** Alternance 25 fps → 12,5 Hz pour le broadcast SSE. */
let tickParity = false;
/** Dernier rafraîchissement de l'état `on` du ruban (throttle 10 s du tick). */
let lastOnRefresh = 0;
/** Suspension UDP courante (log UNE ligne par transition, pas par trame). */
let udpSuspended = false;

// music-mode a besoin de l'état de lecture pour rejouer un rendu différé
// (rallumage) sans importer ce module (cycle) — on lui fournit un callback.
registerPlayingProvider(() => beatStatus().playing);

function buildPacket(frame: Uint8Array): Buffer {
  const b = Buffer.alloc(44);
  b.write(PACKET_HDR, 0, 6, 'latin1');
  const vol = frame[16];
  b.writeFloatLE(vol, 8); // sampleRaw
  b.writeFloatLE(vol, 12); // sampleSmth
  b.writeUInt8(frame[17], 16); // samplePeak
  for (let i = 0; i < 16; i++) b.writeUInt8(frame[i], 18 + i);
  // VRAIE intensité du pic spectral (timeline v3, o.20-21) — plus jamais le
  // volume déguisé : les effets ♫ dosent la note avec, pas le niveau global.
  b.writeFloatLE(frame[20] | (frame[21] << 8), 36); // FFT_Magnitude
  b.writeFloatLE(frame[18] | (frame[19] << 8), 40); // FFT_MajorPeak (Hz)
  return b;
}

const SILENCE = new Uint8Array(20); // volume 0, pas de peak

function tick(): void {
  const s = session;
  if (!s) return;
  // Le mode global est coupé → l'arrêt en découle (plus de stop client).
  if (!isMusicEnabled()) {
    stopBeat();
    return;
  }
  const now = Date.now();
  const stale = now - s.lastHeartbeat > STALE_MS;
  const past = now - s.lastHeartbeat > STALE_MS + 5_000;
  if (past) {
    stopBeat();
    return;
  }
  const posMs = s.playing && !stale ? s.basePosMs + (now - s.baseAt) : s.basePosMs;
  const frame =
    s.playing && !stale && s.timeline && isReactiveStyle() ? frameAt(s.timeline, posMs) : null;

  // SSE : niveau à 12,5 Hz (une trame sur deux) pour l'aperçu de la carte.
  tickParity = !tickParity;
  if (tickParity) {
    broadcastLive({
      level: frame ? frame[16] / 254 : 0,
      peak: frame ? frame[17] : 0,
      key: s.key,
      playing: s.playing && !stale
    });
  }

  // Rafraîchit l'état `on` du ruban toutes les ~10 s : un allumage fait depuis
  // l'app WLED native ou l'interrupteur physique doit désuspendre le stream
  // (et rejouer le rendu différé via noteModuleOn) sans passer par Domo.
  if (now - lastOnRefresh > 10_000) {
    lastOnRefresh = now;
    void moduleGet('state')
      .then(({ data }) => {
        const on = (data as { on?: unknown })?.on === true;
        noteModuleOn(on);
      })
      .catch(() => undefined); // module injoignable : on garde le dernier connu
  }

  // Stream UDP suspendu tant que le ruban est éteint (interrupteur utilisateur).
  const target = relayTarget();
  const suspended = !target || !isModuleOn();
  if (suspended !== udpSuspended) {
    udpSuspended = suspended;
    console.log(
      suspended ? '[wled/beat] stream suspendu (ruban éteint)' : '[wled/beat] stream repris'
    );
  }
  if (suspended) return;
  const pkt = buildPacket(frame ?? SILENCE);
  socket ??= dgram.createSocket('udp4');
  socket.send(pkt, target.port, target.host, () => undefined);
}

function startLoop(): void {
  if (!timer) timer = setInterval(tick, SEND_MS);
}
function stopLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export interface BeatUpdate {
  /** Identifiant stable de la piste (PlexTrack.key). */
  key: string;
  /** Chemin du média (PlexTrack.part) — pour l'analyse au premier passage. */
  part: string;
  positionMs: number;
  playing: boolean;
}

export interface BeatStatus {
  ready: boolean;
  analyzing: boolean;
  /** Piste réellement suivie par le serveur (≠ u.key si heartbeat rejeté). */
  key: string | null;
}

function status(ready: boolean): BeatStatus {
  return { ready, analyzing: analyzing !== null, key: session?.key ?? null };
}

/** Une analyse spectrale est-elle en cours ? (snapshot SSE à la connexion) */
export function isAnalyzing(): boolean {
  return analyzing !== null;
}

/** Lance l'analyse spectrale si nécessaire (styles réactifs uniquement). */
function ensureAnalysis(u: BeatUpdate): void {
  if (!isReactiveStyle() || analyzing === u.key) return;
  analyzing = u.key;
  const startedFor = u.key;
  console.log(`[wled/beat] analyse piste ${u.key} (${u.part})`);
  broadcastLive({ analyzing: true });
  void analyzeTrack(u.part.replace(/^\/+/, ''), u.key)
    .then(async (tl) => {
      console.log(`[wled/beat] analyse ${startedFor} terminée`);
      failedAnalysis.delete(startedFor);
      if (session?.key === startedFor) session.timeline = tl;
    })
    .catch((e) => {
      console.error(`[wled/beat] analyse ${startedFor} échouée:`, (e as Error).message);
      failedAnalysis.set(startedFor, Date.now());
      // Repli : rendu « ambiance » plutôt qu'un effet audio sans données (noir).
      if (session?.key === startedFor) {
        void applyRender(session.playing, { forceAmbiance: true });
      }
    })
    .finally(() => {
      if (analyzing === startedFor) analyzing = null;
      broadcastLive({ analyzing: analyzing !== null });
    });
}

/** Heartbeat de l'appareil qui joue : cale (ou démarre) le stream. */
export async function updateBeat(u: BeatUpdate): Promise<BeatStatus> {
  const now = Date.now();
  if (!isMusicEnabled()) return status(false);

  // ── Même piste : recalage simple (+ transition pause/lecture → rendu) ──
  if (session?.key === u.key) {
    const playingChanged = session.playing !== u.playing;
    session.basePosMs = u.positionMs;
    session.baseAt = now;
    session.playing = u.playing;
    session.lastHeartbeat = now;
    if (playingChanged) {
      void applyRender(u.playing); // pause → fondu multicolore lent ; reprise → effet du style
      broadcastLive({ playing: u.playing, key: u.key });
    }
    // Style devenu réactif EN COURS de piste (session née en « ambiance »),
    // ou analyse échouée retentable : sans timeline, l'effet réactif reçoit
    // du SILENCE en continu = ruban allumé mais noir. On (re)tente le cache
    // puis l'analyse ici — le heartbeat suivant (≤5 s) rattrape le style.
    if (
      u.playing &&
      !session.timeline &&
      isReactiveStyle() &&
      analyzing !== u.key &&
      now - (failedAnalysis.get(u.key) ?? 0) > FAILED_RETRY_MS
    ) {
      const cached = await cachedTimeline(u.key);
      if (session?.key === u.key) {
        if (cached) session.timeline = cached;
        else ensureAnalysis(u);
      }
    }
    startLoop();
    return status(session?.timeline != null || !isReactiveStyle());
  }

  // ── Autre piste : ANTI-DÉTOURNEMENT ──
  // Une session fraîche qui joue ne peut être remplacée que par une NOUVELLE
  // LECTURE (playing=true). Un appareil avec une piste chargée en pause ne
  // prend pas la main.
  if (session && now - session.lastHeartbeat <= STALE_MS && !u.playing) {
    return status(session.timeline !== null);
  }

  const cached = isReactiveStyle() ? await cachedTimeline(u.key) : null;
  console.log(
    `[wled/beat] stream piste ${u.key} pos=${Math.round(u.positionMs / 1000)}s play=${u.playing}` +
      (cached ? '' : isReactiveStyle() ? ' (analyse à venir)' : ' (style ambiance)')
  );
  session = {
    key: u.key,
    timeline: cached,
    basePosMs: u.positionMs,
    baseAt: now,
    playing: u.playing,
    lastHeartbeat: now
  };
  broadcastLive({ key: u.key, playing: u.playing });
  // (Ré)applique le rendu du style — les couleurs sont celles de SA palette
  // multicolore, indépendantes du morceau.
  void applyRender(u.playing);
  if (!cached) ensureAnalysis(u);
  startLoop();
  return status(cached !== null || !isReactiveStyle());
}

/** Arrêt (mode global coupé ou péremption). Plus exposé au client. */
export function stopBeat(): void {
  if (session) {
    console.log('[wled/beat] stream stoppé');
    broadcastLive({ key: null, playing: false, level: 0, peak: 0 });
    // Péremption avec mode encore actif : fondu multicolore lent — jamais
    // un effet audio-réactif sans stream (= ruban allumé mais noir).
    if (isMusicEnabled()) void applyRender(false);
  }
  session = null;
  stopLoop();
  udpSuspended = false; // repart neutre à la prochaine session
}

/** État courant du stream (snapshot SSE + endpoint mode). */
export function beatStatus(): {
  active: boolean;
  key: string | null;
  positionMs: number;
  playing: boolean;
} {
  const s = session;
  if (!s) return { active: false, key: null, positionMs: 0, playing: false };
  const now = Date.now();
  const stale = now - s.lastHeartbeat > STALE_MS;
  const playing = s.playing && !stale;
  const positionMs = playing ? s.basePosMs + (now - s.baseAt) : s.basePosMs;
  return { active: true, key: s.key, positionMs: Math.round(positionMs), playing };
}
