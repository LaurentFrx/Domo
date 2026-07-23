/**
 * GET /api/sb3loop/status — état de la boucle SB3 pour la tuile (derrière le
 * guard d'auth cookie standard) : interrupteur, dernière décision, santé,
 * journal (ring 100).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSb3LoopState } from '$lib/server/sb3loop/engine';

export const GET: RequestHandler = async () => {
  const s = await getSb3LoopState();
  return json({
    enabled: s.enabled,
    autoDisabledReason: s.autoDisabledReason,
    autoDisabledTs: s.autoDisabledTs,
    lastCmdW: s.lastCmdW,
    lastWriteTs: s.lastWriteTs,
    lastTickTs: s.lastTickTs,
    confirmFailCount: s.confirmFailCount,
    decisions: s.decisions.slice(0, 30)
  });
};
