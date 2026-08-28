/**
 * /api/cumulus/relay — état + commande du relais Shelly Pro 1 (cumulus ECS).
 *
 * Proxy serveur vers le Shelly (RPC Gen2) via la loopback du VPS, sortie du
 * tunnel SSH inverse 127.0.0.1:8099 → Shelly 192.168.1.18:80 (cf. sur le RPi4
 * tunnel-8099-shelly.sh + crontab @reboot). Le Shelly n'est JAMAIS exposé au
 * navigateur ni à Internet : le client tape /api/cumulus/relay (derrière le
 * guard d'auth de hooks.server.ts) et SvelteKit relaie server-to-server. Le
 * boîtier n'a pas d'auth → seule cette route (lecture + on/off uniquement) est
 * publiée, jamais le RPC brut.
 *
 *   GET                    → { on: boolean|null, tC: number|null }   (Switch.GetStatus)
 *   POST { on: boolean }   → { on: boolean|null }                    (Switch.Set + relecture)
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const shellyUrl = () => {
  const u = env.SHELLY_CUMULUS_URL;
  if (!u) throw error(503, 'SHELLY_CUMULUS_URL non configurée');
  return u.replace(/\/+$/, '');
};

const TIMEOUT_MS = 8_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${shellyUrl()}${path}`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `Shelly cumulus injoignable (${reason}).`);
  }
  clearTimeout(timer);
  if (!upstream.ok) throw error(502, `Shelly cumulus: HTTP ${upstream.status}`);
  const data = await upstream.json().catch(() => null);
  if (data === null) throw error(502, 'Shelly cumulus: JSON invalide');
  return data;
}

// ── Cache stale-while-revalidate de l'état du relais ──
// Le RPC traverse tunnel SSH → RPi4 → LAN maison : ~0,6 s de TTFB MESURÉS pour
// 20 octets, payés par CHAQUE poll de 10 s des pages eau-chaude/appareils —
// l'état du relais arrivait systématiquement après tout le reste. On sert le
// dernier état connu (≤ 30 s) et on relit le boîtier en arrière-plan : la
// fraîcheur effective ≈ un cycle de poll. Un POST (commande) relit toujours en
// synchrone et met le cache à jour ; au-delà de 30 s sans lecture réussie, on
// repasse en lecture synchrone → une panne du Shelly reste VISIBLE (504) au
// plus tard 30 s après coup, jamais masquée par le cache.
type RelayState = { on: boolean | null; tC: number | null };
const FRESH_MS = 2_500; // rafale multi-clients/multi-pages : une seule lecture
const STALE_MAX_MS = 30_000;
let cache: { at: number; st: RelayState } | null = null;
let refreshing: Promise<unknown> | null = null;

async function readRelay(): Promise<RelayState> {
  const d = await rpc('/rpc/Switch.GetStatus?id=0');
  const st: RelayState = {
    on: typeof d.output === 'boolean' ? d.output : null,
    tC: typeof d?.temperature?.tC === 'number' ? d.temperature.tC : null
  };
  cache = { at: Date.now(), st };
  return st;
}

function refreshInBackground(): void {
  refreshing ??= readRelay()
    .catch(() => {
      /* le prochain GET au-delà de STALE_MAX_MS relira en synchrone et exposera l'erreur */
    })
    .finally(() => {
      refreshing = null;
    });
}

export const GET: RequestHandler = async () => {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < FRESH_MS) return json(cache.st);
  if (cache && age < STALE_MAX_MS) {
    refreshInBackground();
    return json(cache.st);
  }
  return json(await readRelay());
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.on !== 'boolean') {
    throw error(400, 'Corps attendu : { on: boolean }');
  }
  await rpc(`/rpc/Switch.Set?id=0&on=${body.on ? 'true' : 'false'}`);
  // Relecture SYNCHRONE pour confirmer l'état effectif (le relais peut être
  // contraint par l'entrée physique en mode "follow" — on renvoie la vérité du
  // boîtier) ; elle met aussi le cache à jour pour les GET qui suivent.
  const st = await readRelay();
  return json({ on: st.on ?? body.on });
};
