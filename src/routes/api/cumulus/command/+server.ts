/**
 * POST /api/cumulus/command — contrôle utilisateur de l'orchestrateur.
 *
 * Body : { autoMode?: 'auto'|'manual'|'off', manualRelayOn?: boolean }.
 * Met à jour l'état persistant puis déclenche un tick immédiat (réactivité au
 * clic). Forcer le relais bascule implicitement en mode manuel (hors vacances).
 * Derrière l'auth cookie (commande émise depuis l'app authentifiée).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { applyCommand } from '$lib/server/cumulus/engine';
import type { AutoMode } from '$lib/server/cumulus/types';

const MODES: AutoMode[] = ['auto', 'manual', 'off'];

export const POST: RequestHandler = async ({ request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw error(400, 'JSON invalide');
  }

  const cmd: { autoMode?: AutoMode; manualRelayOn?: boolean } = {};
  if (typeof body.autoMode === 'string' && MODES.includes(body.autoMode as AutoMode)) {
    cmd.autoMode = body.autoMode as AutoMode;
  }
  if (typeof body.manualRelayOn === 'boolean') cmd.manualRelayOn = body.manualRelayOn;

  if (cmd.autoMode === undefined && cmd.manualRelayOn === undefined) {
    throw error(400, 'autoMode ou manualRelayOn requis');
  }

  const result = await applyCommand(cmd);
  return json({ ok: true, ...result });
};
