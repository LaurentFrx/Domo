import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readPlanning, writePlanning, normalizePlanning } from '$lib/server/planning-store';

export const GET: RequestHandler = async () => {
  return json(await readPlanning());
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const updated = await writePlanning(normalizePlanning(body));
  return json(updated);
};
