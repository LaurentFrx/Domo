/**
 * Signe de vie lu par le CHIEN DE GARDE de la Max AC, sur le RPi4.
 *
 * Le garde-fou repasse l'appareil en autoconsommation dès que cette route cesse
 * de répondre `controlling: true` — VPS éteint, service redémarré, boucle
 * arrêtée, réseau coupé : tous ces cas se ressemblent vus du RPi4, et tous
 * doivent rendre la main à l'appareil. C'est volontairement la route la plus
 * bête du projet : aucune dépendance, aucune I/O, pas de cache.
 */
import { json } from '@sveltejs/kit';
import { maxAcClaim } from '$lib/server/maxac-control';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  json({ ...maxAcClaim(), ts: Date.now() }, { headers: { 'cache-control': 'no-store' } });
