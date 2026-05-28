import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readSettings, writeSettings, type Settings } from '$lib/server/settings-store';

export const GET: RequestHandler = async () => {
  const settings = await readSettings();
  return json(settings);
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as Settings;
  const updated = await writeSettings(body);
  return json(updated);
};
