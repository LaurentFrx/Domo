/**
 * POST /api/apsloop/command — interrupteur de la boucle APS depuis la tuile.
 * Corps : { enabled?: boolean, observationMode?: boolean }. Derrière l'auth cookie.
 * Couper la boucle (ou repasser en observation) REND le plafond au maximum.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setApsLoopEnabled, setApsLoopObservation, readApsLoop } from '$lib/server/apsloop/engine';

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  const b = (body ?? {}) as { enabled?: unknown; observationMode?: unknown };
  // `enabled` D'ABORD : l'ordre inverse rendait un réarmement en un seul appel
  // impossible — setApsLoopEnabled() repassait la boucle en observation juste
  // après qu'on l'en avait sortie, et la protection revenait sans commander.
  // (Le retour forcé en observation a été retiré depuis, l'ordre reste le bon.)
  if (typeof b.enabled === 'boolean') await setApsLoopEnabled(b.enabled);
  if (typeof b.observationMode === 'boolean') await setApsLoopObservation(b.observationMode);
  if (typeof b.enabled !== 'boolean' && typeof b.observationMode !== 'boolean')
    throw error(400, '{ enabled?: boolean, observationMode?: boolean } requis');
  const s = await readApsLoop();
  return json({
    enabled: s.enabled,
    observationMode: s.observationMode,
    autoDisabledReason: s.autoDisabledReason
  });
};
