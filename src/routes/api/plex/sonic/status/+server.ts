/**
 * GET /api/plex/sonic/status — état de l'analyse sonique maison (data/sonic.db).
 * `analyzed: 0` = base absente ou vide : le client grise les DJ soniques.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sonicStatus } from '$lib/server/sonic';

export const GET: RequestHandler = async () => {
  return json(sonicStatus());
};
