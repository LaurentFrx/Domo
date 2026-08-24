/**
 * GET /api/cumulus/criterion — journal du LABO du critère énergie.
 *
 * LECTURE SEULE. Renvoie les échantillons persistés par engine.ts (bilan du
 * critère, verdict des voies historiques, réel — un point par tick, ~12 h de
 * profondeur) pour la page /cumulus-labo. Derrière l'auth cookie.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCumulusState } from '$lib/server/cumulus/state-store';

export const GET: RequestHandler = async () => {
  const state = await readCumulusState();
  const samples = state.criterionLog ?? [];
  return json(
    {
      lastTickTs: state.lastTickTs,
      current: samples.length ? samples[samples.length - 1] : null,
      samples
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
