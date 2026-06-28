/**
 * Proxy serveur (lecture + commande) vers le contrôleur WLED (QuinLed Dig-Uno).
 *
 * Le client appelle les mêmes chemins que l'API WLED native, préfixés :
 *   GET  /api/wled/json        → état complet + effets + palettes
 *   GET  /api/wled/json/si     → { state, info } (polling léger)
 *   POST /api/wled/json/state  → applique un patch d'état
 *
 * Aiguillage par la variable d'env PRIVÉE `WLED_URL` :
 *   - absente OU = 'mock'  → sert le mock en mémoire (src/lib/server/wled-mock)
 *   - http://<ip|loopback> → proxifie le vrai module (modèle airzone/daikin)
 *
 * Un en-tête `x-wled-source: mock|live` permet au store d'afficher le bon badge
 * (« Démo » tant que le vrai module n'est pas branché). Tout passe par le node
 * derrière le guard d'auth : le module n'a pas besoin d'être exposé publiquement.
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { wledGet, wledPostState } from '$lib/server/wled-mock';
import type { RequestHandler } from './$types';

const TIMEOUT_MS = 8_000;

/** Base du vrai module, ou null si on doit servir le mock. */
function liveBase(): string | null {
  const u = (env.WLED_URL || '').trim().replace(/\/+$/, '');
  if (!u || u.toLowerCase() === 'mock') return null;
  return u;
}

/** Sous-chemin après `json/` (params.path = 'json' | 'json/si' | 'json/state'…). */
function subPath(path: string | undefined): string {
  return (path || '').replace(/^json\/?/, '').replace(/^\/+/, '');
}

// Sous-chemins GET autorisés (lecture seule). Défense en profondeur : on ne
// relaie PAS un chemin arbitraire vers le module LAN (config/win/reboot…),
// même derrière l'auth — seule la lecture de l'état est exposée.
const ALLOWED_GET = new Set(['', 'state', 'info', 'si', 'eff', 'pal']);

const MOCK_HEADERS = { 'x-wled-source': 'mock', 'cache-control': 'no-store' };
const LIVE_HEADERS = { 'x-wled-source': 'live', 'cache-control': 'no-store' };

export const GET: RequestHandler = async ({ params }) => {
  const sub = subPath(params.path);
  if (!ALLOWED_GET.has(sub)) throw error(404, 'WLED: chemin non autorisé');

  const base = liveBase();
  if (!base) {
    return json(wledGet(sub), { headers: MOCK_HEADERS });
  }

  // URL reconstruite à partir de la liste fermée (jamais params.path brut).
  const url = sub ? `${base}/json/${sub}` : `${base}/json`;
  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    throw error(504, `WLED injoignable (${reason}).`);
  }
  if (!upstream.ok) throw error(502, `WLED: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'WLED: JSON invalide');
  return json(data, { headers: LIVE_HEADERS });
};

export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }

  const base = liveBase();
  if (!base) {
    return json(wledPostState(body), { headers: MOCK_HEADERS });
  }

  // Sur le vrai module, toute commande passe par /json/state.
  const url = `${base}/json/state`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    throw error(504, `WLED injoignable (${reason}).`);
  }
  if (!upstream.ok) throw error(502, `WLED: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => ({ success: true }));
  return json(data, { headers: LIVE_HEADERS });
};
