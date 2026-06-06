/**
 * Tarif électricité COURANT — expose la vraie logique HP/HC (server-only
 * `$lib/server/tariffs`, source `data/tariffs.json`) au client, qui ne peut pas
 * importer le module serveur. Remplace le mock `mock-curves` (fenêtre HC fausse).
 *
 * Renvoie : période en cours, prix €/kWh, et la prochaine bascule (période + heure
 * locale Paris + délai en minutes). Tout est DST-aware via Intl côté tariffs.ts.
 */
import { json } from '@sveltejs/kit';
import { priceAt, nextTariffSwitch } from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  const now = new Date();
  const p = priceAt(now);
  const next = nextTariffSwitch(now);
  return json({
    period: p.period,
    price_eur_kwh: p.eur_kwh,
    next: {
      period: next.period,
      at: next.atHHMM,
      in_minutes: next.inMinutes
    }
  });
};
