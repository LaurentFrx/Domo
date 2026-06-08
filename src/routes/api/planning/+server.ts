import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readPlanning, writePlanning, normalizePlanning } from '$lib/server/planning-store';
import { env } from '$env/dynamic/private';

/**
 * Chaînon planning → daemon : à chaque sauvegarde réussie, on pousse le planning
 * v2 au thermostat-bridge (/command). Best-effort : si le daemon est injoignable,
 * le PUT réussit quand même ; le daemon reprendra au prochain PUT (et conserve sa
 * dernière copie dans state.json).
 */
async function pushToBridge(planning: unknown): Promise<void> {
  const u = env.THERMOSTAT_BRIDGE_URL;
  if (!u) return;
  try {
    await fetch(`${u.replace(/\/+$/, '')}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planning }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    /* daemon down → on n'échoue pas le PUT */
  }
}

export const GET: RequestHandler = async () => {
  return json(await readPlanning());
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const updated = await writePlanning(normalizePlanning(body));
  await pushToBridge(updated);
  return json(updated);
};
