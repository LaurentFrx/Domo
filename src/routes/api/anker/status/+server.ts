/**
 * /api/anker/status — lecture du bridge cloud Anker Solix (anker-bridge sur le
 * RPi4, FastAPI :8095), joint par Tailscale via l'env PRIVÉE `ANKER_URL`.
 *
 * MÊME modèle que /api/em50/status et /api/cumulus/relay : le bridge n'est
 * JAMAIS exposé au navigateur ni à Internet ; le client tape /api/anker/status
 * (derrière le guard d'auth de hooks.server.ts) et SvelteKit relaie
 * server-to-server.
 *
 * Avant cette route, le store client appelait https://domo.feroux.fr/anker/api/status
 * via un `handle_path /anker/*` de Caddy qui ne traversait PAS SvelteKit : le
 * guard d'auth était structurellement inatteignable, et le bridge servait
 * publiquement /docs, /openapi.json et /api/debug (n° de série des batteries,
 * site_id, nom du domicile). Le bloc Caddy a été retiré en même temps.
 *
 * Le payload du bridge est relayé TEL QUEL : c'est le contrat déjà consommé par
 * le store (type ApiPayload). Le 503 « credentials Solix absents » est relayé
 * avec son corps, car le store le distingue d'une panne réseau (état
 * 'unconfigured' vs 'error').
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// Aligné sur le timeout du store client (15 s) : le bridge sert un cache
// rafraîchi côté cloud Solix toutes les ~60 s, il peut être lent au réveil.
const TIMEOUT_MS = 15_000;

const bridgeUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

export const GET: RequestHandler = async () => {
  let upstream: Response;
  try {
    upstream = await fetch(`${bridgeUrl()}/api/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    throw error(504, `anker-bridge injoignable (${reason}).`);
  }

  const data = await upstream.json().catch(() => null);

  // Bridge démarré mais sans ANKER_EMAIL/ANKER_PASSWORD : statut ET corps
  // conservés, le store y lit `detail`.
  if (upstream.status === 503) {
    return json(data ?? { detail: 'service unavailable' }, { status: 503 });
  }
  if (!upstream.ok) throw error(502, `anker-bridge: HTTP ${upstream.status}`);
  if (data === null) throw error(502, 'anker-bridge: JSON invalide');

  return json(data);
};
