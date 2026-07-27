/** GET /api/apsloop/status — état de la boucle de bridage APS (lecture seule). */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readApsLoop } from '$lib/server/apsloop/engine';

export const GET: RequestHandler = async () => {
  const s = await readApsLoop();
  return json(s, { headers: { 'cache-control': 'no-store' } });
};
