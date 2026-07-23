/**
 * POST /api/sb3loop/command — interrupteur de la boucle SB3 depuis la tuile
 * (derrière le guard d'auth cookie standard). Corps : { enabled: boolean }.
 * Réactiver efface l'auto-désactivation (canary / consignes non prises).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setSb3LoopEnabled } from '$lib/server/sb3loop/engine';

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== 'boolean') throw error(400, '{ enabled: boolean } requis');
  const s = await setSb3LoopEnabled(enabled);
  return json({ enabled: s.enabled, autoDisabledReason: s.autoDisabledReason });
};
