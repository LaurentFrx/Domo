/**
 * GET/PUT /api/cumulus/config — config de l'orchestrateur (section `cumulus` de
 * settings.json). Le PUT merge + normalise (bornes saines) et renvoie la version
 * effective. Derrière l'auth cookie (édité depuis /reglages).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCumulusConfig, writeCumulusConfig } from '$lib/server/cumulus/config';
import type { CumulusConfig } from '$lib/server/cumulus/types';

export const GET: RequestHandler = async () => {
  return json(await readCumulusConfig());
};

export const PUT: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  if (!body || typeof body !== 'object') throw error(400, 'corps invalide');
  const cfg = await writeCumulusConfig(body as Partial<CumulusConfig>);
  return json(cfg);
};
