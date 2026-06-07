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

export const GET: RequestHandler = async () => {
  const d = await rpc('/rpc/Switch.GetStatus?id=0');
  return json({
    on: typeof d.output === 'boolean' ? d.output : null,
    tC: typeof d?.temperature?.tC === 'number' ? d.temperature.tC : null
  });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.on !== 'boolean') {
    throw error(400, 'Corps attendu : { on: boolean }');
  }
  await rpc(`/rpc/Switch.Set?id=0&on=${body.on ? 'true' : 'false'}`);
  // Relecture pour confirmer l'état effectif (le relais peut être contraint par
  // l'entrée physique en mode "follow" — on renvoie la vérité du boîtier).
  const st = await rpc('/rpc/Switch.GetStatus?id=0');
  return json({ on: typeof st.output === 'boolean' ? st.output : body.on });
};
