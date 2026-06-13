/**
 * POST /api/cumulus/tick — déclenche un tick de l'orchestrateur cumulus.
 *
 * Appelé toutes les 60 s par le timer systemd (curl localhost) SANS cookie Domo.
 * Auth dédiée par `Authorization: Bearer <CUMULUS_TICK_TOKEN>` (comparaison à
 * temps constant) ; le bypass du guard de cookie pour CE chemin exact est dans
 * src/hooks.server.ts (modèle /api/portail/pulse).
 *
 * `?apply=false` → dry-run (calcule et journalise la décision sans piloter le
 * relais ni fausser les compteurs anti-court-cycle) : utile au calibrage.
 */

import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { tick } from '$lib/server/cumulus/engine';

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

// Rate-limit léger (le timer tape 1/min ; marge pour les ticks manuels/command).
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

export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  let ip = 'unknown';
  try {
    ip = getClientAddress();
  } catch {
    // adresse indisponible — non bloquant
  }
  if (rateLimited(ip)) return json({ ok: false, error: 'rate_limited' }, { status: 429 });

  const expected = env.CUMULUS_TICK_TOKEN;
  if (!expected) {
    console.error('[cumulus/tick] CUMULUS_TICK_TOKEN non configuré — refus');
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const apply = url.searchParams.get('apply') !== 'false';
  try {
    const result = await tick(apply);
    return json({ ok: true, dryRun: !apply, ...result });
  } catch (e) {
    console.error('[cumulus/tick] erreur:', (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
};
