/**
 * POST /api/temperature/tick — échantillonne toutes les sondes et persiste un
 * point par capteur dans `data/temps.db`.
 *
 * Appelé toutes les 60 s par le timer systemd `domo-temps` (curl localhost) SANS
 * cookie Domo. Auth dédiée par `Authorization: Bearer <TEMPS_TICK_TOKEN>`
 * (comparaison à temps constant) ; le bypass du guard de cookie pour CE chemin
 * exact est dans src/hooks.server.ts (modèle /api/cumulus/tick).
 *
 * Tourne DANS le process domo.service → le cache MQTT des sondes reste chaud
 * entre les ticks (comme l'orchestrateur cumulus).
 */

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { collectAll } from '$lib/server/temperature/collect';
import { insertSamples, purgeOld } from '$lib/server/temperature/db';

const RETENTION_S = 48 * 3600;
const TICK_TIMEOUT_MS = 45_000;

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}
function tokenMatches(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}
function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

// Rate-limit léger (le timer tape 1/min ; marge pour les ticks manuels).
const RL_WINDOW_MS = 60_000;
const RL_MAX = 30;
const rlHits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (rlHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  recent.push(now);
  rlHits.set(ip, recent);
  if (rlHits.size > 500) {
    for (const [k, v] of rlHits) if (v.every((t) => now - t >= RL_WINDOW_MS)) rlHits.delete(k);
  }
  return recent.length > RL_MAX;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('tick timeout')), ms))
  ]);
}

// Mutex : pas de ticks concurrents (timer + déclenchement manuel simultanés).
let ticking = false;

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  let ip = 'unknown';
  try {
    ip = getClientAddress();
  } catch {
    // adresse indisponible — non bloquant
  }
  if (rateLimited(ip)) return json({ ok: false, error: 'rate_limited' }, { status: 429 });

  const expected = env.TEMPS_TICK_TOKEN;
  if (!expected) {
    console.error('[temps/tick] TEMPS_TICK_TOKEN non configuré — refus');
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  if (ticking) return json({ ok: false, error: 'busy' }, { status: 409 });
  ticking = true;
  try {
    const samples = await withTimeout(collectAll(), TICK_TIMEOUT_MS);
    insertSamples(samples);
    purgeOld(Math.floor(Date.now() / 1000) - RETENTION_S);
    const written = samples.filter((s) => s.tempC != null).length;
    return json({ ok: true, sensors: samples.length, written });
  } catch (e) {
    console.error('[temps/tick] erreur:', (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    ticking = false;
  }
};
