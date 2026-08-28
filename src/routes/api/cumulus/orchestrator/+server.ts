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
  // Deux journaux SERVEUR ne sortent pas : `criterionLog` (validation du critère
  // énergie, ~166 Ko, lu par /api/cumulus/criterion pour le labo) et `pilot`
  // (état interne V2 brut, ~20 Ko — l'UI ne lit que sa projection `pilotView`).
  // Les renvoyer faisait peser 213 Ko sérialisés + parsés par poll de 20 s,
  // pour des champs que le client n'a JAMAIS lus. ~27 Ko après ablation.
  let uiState: unknown = state;
  if (state && typeof state === 'object') {
    const { criterionLog, pilot, ...rest } = state;
    void criterionLog;
    void pilot;
    uiState = rest;
  }
  return json({ state: uiState, config });
};
