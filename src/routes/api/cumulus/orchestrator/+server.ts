/**
 * GET /api/cumulus/orchestrator — état complet de l'orchestrateur pour l'UI.
 *
 * Renvoie l'état runtime persisté (mode, dernière décision + raison, énergie du
 * jour, anomalie, heartbeat lastTickTs, journal des décisions) et la config
 * effective. Lecture seule (2 fichiers JSON) — la conso/température « live »
 * viennent des stores em50/zigbee déjà connectés. Derrière l'auth cookie.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCumulusState } from '$lib/server/cumulus/state-store';
import { readCumulusConfig } from '$lib/server/cumulus/config';

export const GET: RequestHandler = async () => {
  const [state, config] = await Promise.all([readCumulusState(), readCumulusConfig()]);
  return json({ state, config });
};
