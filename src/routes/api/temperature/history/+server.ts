/**
 * GET /api/temperature/history?sensor=<clé>&hours=<1..48> — série historique
 * d'un capteur, lecture seule de `data/temps.db`.
 *
 * Le `sensor` est validé contre le registre fermé (anti-injection) ; `hours` est
 * borné. Route derrière le guard d'auth (hooks.server.ts). DB absente/illisible
 * → 503 + `points: []`, jamais de crash (modèle /api/production/history).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { querySeries } from '$lib/server/temperature/db';
import { isValidSensorKey, comfortBand } from '$lib/server/temperature/registry';

export const GET: RequestHandler = async ({ url }) => {
  const sensor = url.searchParams.get('sensor') ?? '';
  if (!isValidSensorKey(sensor)) {
    return json({ points: [], error: 'unknown_sensor' }, { status: 400 });
  }

  const raw = Number(url.searchParams.get('hours') ?? '4');
  const hours = Number.isFinite(raw) ? Math.min(48, Math.max(1, Math.trunc(raw))) : 4;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  try {
    const points = querySeries(sensor, since);
    return json({ sensor, points, comfort: comfortBand(sensor) });
  } catch (e) {
    console.error('[temps/history] DB error:', e instanceof Error ? e.message : e);
    return json({ points: [], error: 'database_unavailable' }, { status: 503 });
  }
};
