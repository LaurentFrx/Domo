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
 * Synchronisation : le client remonte {position, playing} par heartbeat ; le
 * serveur EXTRAPOLE entre deux heartbeats (l'app iOS en arrière-plan continue
 * la musique mais ses timers JS gèlent). Failsafe : sans heartbeat depuis
 * STALE_MS, on fige — jamais de stream fantôme.
 */

import dgram from 'node:dgram';
import { env } from '$env/dynamic/private';
import { analyzeTrack, cachedTimeline, frameAt, type Timeline } from './audio-analysis';

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
  timeline: Timeline;
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

function buildPacket(frame: Uint8Array): Buffer {
  const b = Buffer.alloc(44);
  b.write(PACKET_HDR, 0, 6, 'latin1');
  const vol = frame[16];
  b.writeFloatLE(vol, 8); // sampleRaw
  b.writeFloatLE(vol, 12); // sampleSmth
  b.writeUInt8(frame[17], 16); // samplePeak
  for (let i = 0; i < 16; i++) b.writeUInt8(frame[i], 18 + i);
  b.writeFloatLE(vol * 80, 36); // FFT_Magnitude (échelle interne, indicatif)
  b.writeFloatLE(frame[18] | (frame[19] << 8), 40); // FFT_MajorPeak (Hz)
  return b;
}

const SILENCE = new Uint8Array(20); // volume 0, pas de peak

function tick(): void {
  const s = session;
  const target = relayTarget();
  if (!s || !target) return;
  const now = Date.now();
  const stale = now - s.lastHeartbeat > STALE_MS;
  const posMs = s.playing && !stale ? s.basePosMs + (now - s.baseAt) : s.basePosMs;
  const frame = s.playing && !stale ? frameAt(s.timeline, posMs) : null;
  // Pause / fin de piste / stale : quelques trames de silence puis on se tait
  // (le firmware repasse en « idle » de lui-même après 10 s sans paquets).
  const past = now - s.lastHeartbeat > STALE_MS + 5_000;
  if (!frame && past) {
    stopLoop();
    return;
  }
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
}

/** Heartbeat du client : cale (ou démarre) le stream sur la position donnée. */
export async function updateBeat(u: BeatUpdate): Promise<BeatStatus> {
  const now = Date.now();
  if (session?.key === u.key) {
    session.basePosMs = u.positionMs;
    session.baseAt = now;
    session.playing = u.playing;
    session.lastHeartbeat = now;
    startLoop();
    return { ready: true, analyzing: false };
  }

  // Nouvelle piste : timeline en cache → démarrage immédiat ; sinon analyse
  // en arrière-plan (le heartbeat suivant la trouvera prête).
  const cached = await cachedTimeline(u.key);
  if (cached) {
    session = {
      key: u.key,
      timeline: cached,
      basePosMs: u.positionMs,
      baseAt: now,
      playing: u.playing,
      lastHeartbeat: now
    };
    startLoop();
    return { ready: true, analyzing: false };
  }

  if (analyzing !== u.key) {
    analyzing = u.key;
    const startedFor = u.key;
    void analyzeTrack(u.part.replace(/^\/+/, ''), u.key)
      .catch((e) => {
        console.error('[wled/beat] analyse échouée:', (e as Error).message);
      })
      .finally(() => {
        if (analyzing === startedFor) analyzing = null;
      });
  }
  return { ready: false, analyzing: true };
}

/** Arrêt explicite (mode musique désactivé, reprise manuelle, style ambiance). */
export function stopBeat(): void {
  session = null;
  stopLoop();
}
