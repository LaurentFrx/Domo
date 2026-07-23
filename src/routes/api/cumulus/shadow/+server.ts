/**
 * GET /api/cumulus/shadow — journal du modèle SHADOW de désirabilité (diagnostic).
 *
 * LECTURE SEULE. Renvoie les échantillons persistés par engine.ts (ce que le modèle
 * continu « aurait » décidé, sans jamais toucher le relais) + les seuils d'hystérésis
 * pour tracer les lignes de repère. Derrière l'auth cookie (page /cumulus-labo).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCumulusState } from '$lib/server/cumulus/state-store';
import { readCumulusConfig } from '$lib/server/cumulus/config';
import { defaultDesConfig } from '$lib/server/cumulus/desirability';

export const GET: RequestHandler = async () => {
  const [state, config] = await Promise.all([readCumulusState(), readCumulusConfig()]);
  const samples = state.desirShadowLog ?? [];
  const cfg = defaultDesConfig();
  return json(
    {
      observationMode: config.observationMode,
      dOn: cfg.dOn,
      dOff: cfg.dOff,
      lastTickTs: state.lastTickTs,
      current: samples.length ? samples[samples.length - 1] : null,
      samples
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
