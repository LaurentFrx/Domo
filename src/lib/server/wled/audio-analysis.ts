/**
 * Analyse spectrale d'une piste Plex pour l'éclairage audio-réactif.
 *
 * « Purement numérique » : pas de micro — le fichier audio est décodé côté
 * serveur (ffmpeg → PCM mono 22 050 Hz), passé en FFT (1024 points, Hann,
 * 25 trames/s) et réduit aux données que le firmware WLED consomme via son
 * protocole sound-sync : volume, pic (battement), 16 bandes de fréquences
 * (échelle log ~45 Hz → 10 kHz, comme le GEQ WLED) et fréquence dominante.
 *
 * Le résultat est une timeline compacte (20 octets/trame ≈ 120 Ko pour 4 min),
 * mise en cache disque par piste — un morceau n'est analysé qu'une fois.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pmsFetch } from '$lib/server/plex';

const CACHE_DIR = 'data/audio-fft';
const CACHE_MAX_FILES = 80;
const MAGIC = 0x57_46_46_54; // "WFFT"
export const FPS = 25;
export const BYTES_PER_FRAME = 20; // 16 bandes + volume + peak + majorPeak(u16)

const SAMPLE_RATE = 22050;
const FFT_SIZE = 1024;
const HOP = SAMPLE_RATE / FPS; // 882 échantillons par trame

export interface Timeline {
  fps: number;
  frames: number;
  /** frames × 20 o : [b0..b15, volume, peak, majorPeakHz_lo, majorPeakHz_hi] */
  data: Uint8Array;
}

export function frameAt(tl: Timeline, ms: number): Uint8Array | null {
  const idx = Math.floor((ms / 1000) * tl.fps);
  if (idx < 0 || idx >= tl.frames) return null;
  return tl.data.subarray(idx * BYTES_PER_FRAME, (idx + 1) * BYTES_PER_FRAME);
}

// ─── Cache disque ────────────────────────────────────────────────

function cachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, createHash('sha1').update(cacheKey).digest('hex') + '.bin');
}

async function readCache(cacheKey: string): Promise<Timeline | null> {
  try {
    const buf = await readFile(cachePath(cacheKey));
    if (buf.length < 12 || buf.readUInt32BE(0) !== MAGIC) return null;
    const fps = buf.readUInt16BE(4);
    const frames = buf.readUInt32BE(6);
    const data = new Uint8Array(buf.subarray(12, 12 + frames * BYTES_PER_FRAME));
    if (data.length !== frames * BYTES_PER_FRAME) return null;
    return { fps, frames, data };
  } catch {
    return null;
  }
}

async function writeCache(cacheKey: string, tl: Timeline): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const head = Buffer.alloc(12);
  head.writeUInt32BE(MAGIC, 0);
  head.writeUInt16BE(tl.fps, 4);
  head.writeUInt32BE(tl.frames, 6);
  await writeFile(cachePath(cacheKey), Buffer.concat([head, Buffer.from(tl.data)]));
  void pruneCache();
}

/** Garde le cache borné (LRU par date de modification). */
async function pruneCache(): Promise<void> {
  try {
    const files = await readdir(CACHE_DIR);
    if (files.length <= CACHE_MAX_FILES) return;
    const stats = await Promise.all(
      files.map(async (f) => ({ f, m: (await stat(path.join(CACHE_DIR, f))).mtimeMs }))
    );
    stats.sort((a, b) => a.m - b.m);
    for (const { f } of stats.slice(0, files.length - CACHE_MAX_FILES)) {
      await unlink(path.join(CACHE_DIR, f)).catch(() => undefined);
    }
  } catch {
    /* cache best-effort */
  }
}

// ─── FFT radix-2 (offline, 25 appels/s de piste : très peu de calcul) ───

const N = FFT_SIZE;
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
// Tables bit-reverse + twiddle précalculées
const rev = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < 10; b++) r = (r << 1) | ((i >> b) & 1);
  rev[i] = r;
}
const cosT = new Float32Array(N / 2);
const sinT = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  cosT[i] = Math.cos((-2 * Math.PI * i) / N);
  sinT[i] = Math.sin((-2 * Math.PI * i) / N);
}

/** FFT in-place sur re/im (longueur 1024). */
function fft(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const tw = k * step;
        const tr = re[i + k + half] * cosT[tw] - im[i + k + half] * sinT[tw];
        const ti = re[i + k + half] * sinT[tw] + im[i + k + half] * cosT[tw];
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

// 16 bandes log ~45 Hz → 10 kHz (bornes géométriques, esprit GEQ WLED)
const BAND_EDGES: number[] = (() => {
  const lo = 45;
  const hi = 10000;
  const edges = [];
  for (let i = 0; i <= 16; i++) edges.push(lo * Math.pow(hi / lo, i / 16));
  return edges;
})();
const binHz = SAMPLE_RATE / N;

// ─── Décodage ffmpeg ─────────────────────────────────────────────

async function decodeToPcm(partPath: string): Promise<Int16Array> {
  const upstream = await pmsFetch(`/${partPath}`, { timeoutMs: 0 });
  if (!upstream.ok || !upstream.body) throw new Error(`Plex stream HTTP ${upstream.status}`);

  const ff = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    'pipe:1'
  ]);

  const chunks: Buffer[] = [];
  ff.stdout.on('data', (c: Buffer) => chunks.push(c));
  let ffErr = '';
  ff.stderr.on('data', (c: Buffer) => (ffErr += c.toString()));

  // Pompe le flux HTTP vers stdin de ffmpeg (EPIPE toléré : ffmpeg peut fermer
  // stdin dès qu'il a le container complet).
  const pump = (async () => {
    try {
      const src = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
      for await (const chunk of src) {
        if (!ff.stdin.writable) break;
        if (!ff.stdin.write(chunk)) {
          await new Promise((r) => ff.stdin.once('drain', r));
        }
      }
    } catch {
      /* flux interrompu : ffmpeg travaillera sur ce qu'il a reçu */
    } finally {
      try {
        ff.stdin.end();
      } catch {
        /* déjà fermé */
      }
    }
  })();
  ff.stdin.on('error', () => undefined); // EPIPE

  const code: number = await new Promise((resolve) => ff.on('close', resolve));
  await pump;
  if (code !== 0 && chunks.length === 0) {
    throw new Error(`ffmpeg a échoué (${code}): ${ffErr.slice(0, 200)}`);
  }
  const pcm = Buffer.concat(chunks);
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
}

// ─── Analyse ─────────────────────────────────────────────────────

const inflight = new Map<string, Promise<Timeline>>();

/** Timeline en cache, sans déclencher d'analyse. */
export async function cachedTimeline(cacheKey: string): Promise<Timeline | null> {
  return readCache(cacheKey);
}

/** Analyse (ou récupère du cache) la piste. Dédoublonne les appels concurrents. */
export async function analyzeTrack(partPath: string, cacheKey: string): Promise<Timeline> {
  const cached = await readCache(cacheKey);
  if (cached) return cached;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const p = (async () => {
    try {
      const tl = await computeTimeline(partPath);
      await writeCache(cacheKey, tl);
      return tl;
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, p);
  return p;
}

async function computeTimeline(partPath: string): Promise<Timeline> {
  const pcm = await decodeToPcm(partPath);
  const nFrames = Math.max(0, Math.floor((pcm.length - N) / HOP));
  if (nFrames < FPS) throw new Error('piste trop courte ou décodage vide');

  const data = new Uint8Array(nFrames * BYTES_PER_FRAME);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const bandsRaw = new Float32Array(nFrames * 16);
  const volRaw = new Float32Array(nFrames);
  const peakHz = new Float32Array(nFrames);
  const bassFlux = new Float32Array(nFrames);
  let prevBass = 0;

  for (let f = 0; f < nFrames; f++) {
    const off = Math.floor(f * HOP);
    let rms = 0;
    for (let i = 0; i < N; i++) {
      const s = (pcm[off + i] ?? 0) / 32768;
      re[i] = s * hann[i];
      im[i] = 0;
      rms += s * s;
    }
    volRaw[f] = Math.sqrt(rms / N);
    fft(re, im);

    // Énergie par bande (log-bandes) + bin dominant
    let maxMag = 0;
    let maxBin = 1;
    for (let b = 0; b < 16; b++) {
      const from = Math.max(1, Math.round(BAND_EDGES[b] / binHz));
      const to = Math.max(from + 1, Math.round(BAND_EDGES[b + 1] / binHz));
      let acc = 0;
      for (let k = from; k < to && k < N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        acc += mag;
        if (mag > maxMag && k * binHz > 80) {
          maxMag = mag;
          maxBin = k;
        }
      }
      bandsRaw[f * 16 + b] = acc / Math.max(1, to - from);
    }
    peakHz[f] = maxBin * binHz;

    // Flux d'énergie basses (bandes 0-2) pour la détection de battement
    const bass = bandsRaw[f * 16] + bandsRaw[f * 16 + 1] + bandsRaw[f * 16 + 2];
    bassFlux[f] = Math.max(0, bass - prevBass);
    prevBass = bass;
  }

  // Normalisation type AGC : p95 du morceau → 254 (compression douce racine).
  const q = (arr: Float32Array, p: number) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 1e-6;
  };
  const bandRef = q(bandsRaw, 0.95);
  const volRef = q(volRaw, 0.95);
  const fluxRef = q(bassFlux, 0.97);

  for (let f = 0; f < nFrames; f++) {
    const o = f * BYTES_PER_FRAME;
    for (let b = 0; b < 16; b++) {
      const v = Math.sqrt(Math.min(1.6, bandsRaw[f * 16 + b] / bandRef));
      data[o + b] = Math.min(254, Math.round(v * 200));
    }
    const vol = Math.sqrt(Math.min(1.6, volRaw[f] / volRef));
    data[o + 16] = Math.min(254, Math.round(vol * 200));
    data[o + 17] = bassFlux[f] > fluxRef * 0.85 ? 1 : 0; // battement
    const hz = Math.max(1, Math.min(11025, Math.round(peakHz[f])));
    data[o + 18] = hz & 0xff;
    data[o + 19] = hz >> 8;
  }
  return { fps: FPS, frames: nFrames, data };
}
