/**
 * Accès SERVEUR au contrôleur WLED — même aiguillage que le proxy
 * /api/wled/[...path] : env privée `WLED_URL` absente ou 'mock' → mock en
 * mémoire ; sinon le vrai module. Utilisé par music-mode.ts pour appliquer le
 * rendu musique côté serveur (le client ne pilote plus ce rendu).
 */

import { env } from '$env/dynamic/private';
import { wledGet, wledPostState } from '$lib/server/wled-mock';

const TIMEOUT_MS = 8_000;

function liveBase(): string | null {
  const u = (env.WLED_URL || '').trim().replace(/\/+$/, '');
  if (!u || u.toLowerCase() === 'mock') return null;
  return u;
}

export type WledSource = 'mock' | 'live';

/** GET /json[/<sub>] du module (ou du mock). */
export async function moduleGet(
  sub: '' | 'state' | 'info' | 'si' | 'eff' | 'pal' = ''
): Promise<{ data: unknown; source: WledSource }> {
  const base = liveBase();
  if (!base) return { data: wledGet(sub), source: 'mock' };
  const url = sub ? `${base}/json/${sub}` : `${base}/json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`WLED HTTP ${res.status}`);
  return { data: await res.json(), source: 'live' };
}

/** POST /json/state (patch d'état) vers le module (ou le mock). */
export async function modulePostState(state: unknown): Promise<WledSource> {
  const base = liveBase();
  if (!base) {
    wledPostState(state);
    return 'mock';
  }
  const res = await fetch(`${base}/json/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`WLED HTTP ${res.status}`);
  return 'live';
}
