/**
 * POST /api/monitor/tick — un cycle du moniteur de fiabilité.
 *
 * Déclenché toutes les 60 s par le timer systemd `domo-monitor` (curl localhost)
 * SANS cookie. Auth par `Authorization: Bearer <MONITOR_TOKEN>` (temps constant) ;
 * bypass du guard de cookie pour CE chemin exact dans hooks.server.ts.
 *
 * Cycle : sonder toutes les sources → auto-réparer ce qui peut l'être → notifier
 * (Web Push) les nouvelles anomalies. Tout est journalisé et porté au bus
 * d'incidents (lu par /api/health → bandeau in-app + page Réglages).
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { runProbes } from '$lib/server/monitor/probes';
import { autoRepair } from '$lib/server/monitor/repair';
import { notifyNewIncidents, notifyResolved } from '$lib/server/monitor/notify';
import { activeIncidents } from '$lib/server/monitor/incidents';

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}
function tokenMatches(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}
function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export const POST: RequestHandler = async ({ request }) => {
  const expected = env.MONITOR_TOKEN;
  if (!expected) {
    console.error('[monitor/tick] MONITOR_TOKEN non configuré — refus');
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const provided = extractBearer(request.headers.get('authorization'));
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runProbes();
    const repaired = await autoRepair(summary);
    const pushed = await notifyNewIncidents();
    const recovered = await notifyResolved(summary.resolved);
    return json({
      ok: true,
      checked: summary.checked,
      raised: summary.raised,
      resolved: summary.resolved,
      recorderAgeS: summary.recorderAgeS,
      repaired,
      pushed,
      recovered,
      active: activeIncidents().length
    });
  } catch (e) {
    console.error('[monitor/tick] erreur:', (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
};
