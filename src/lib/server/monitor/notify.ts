/**
 * Politique de notification — décide QUOI pousser en Web Push, sans spam.
 *
 * - 'critical' : poussé immédiatement (dès la 1ʳᵉ détection).
 * - 'warning'  : poussé seulement s'il PERSISTE (anti-flapping d'une source qui
 *   clignote). Le bandeau in-app, lui, montre tout, tout de suite.
 *
 * Si personne n'est abonné, on ne « consomme » pas le flag `notified` : ainsi,
 * dès que Laurent active les alertes, une anomalie encore active est notifiée au
 * tick suivant (pas de fenêtre aveugle).
 */
import { activeIncidents, getIncident, markNotified, type Incident } from './incidents';
import { sendPush, subscriptionCount } from './push';

const WARN_PUSH_DELAY_MS = 5 * 60 * 1000;

function shouldNotify(i: Incident): boolean {
  if (i.notified) return false;
  if (i.severity === 'critical') return true;
  if (i.severity === 'warning') return Date.now() - i.firstTs >= WARN_PUSH_DELAY_MS;
  return false;
}

export async function notifyNewIncidents(): Promise<number> {
  if (subscriptionCount() === 0) return 0; // pas d'abonné : on garde l'alerte « en attente »
  const toNotify = activeIncidents().filter(shouldNotify);
  let sent = 0;
  for (const i of toNotify) {
    const n = await sendPush({
      title: i.severity === 'critical' ? '🔴 Domo — anomalie détectée' : '🟠 Domo — alerte',
      body: i.message,
      tag: i.key,
      severity: i.severity,
      url: '/reglages'
    });
    markNotified(i.key);
    sent += n;
  }
  return sent;
}

function recoveryMessage(i: Incident): string {
  if (i.key === 'apsystems:blind')
    return 'Onduleur solaire rétabli — données manquantes réconciliées automatiquement.';
  if (i.key === 'recorder:stalled') return 'Enregistreur de données de nouveau opérationnel.';
  return `${i.source} de nouveau opérationnel.`;
}

/** Notifie le RÉTABLISSEMENT des anomalies qu'on avait alertées (rassurance). */
export async function notifyResolved(keys: string[]): Promise<number> {
  if (subscriptionCount() === 0 || keys.length === 0) return 0;
  let sent = 0;
  for (const key of keys) {
    const inc = getIncident(key);
    if (!inc || !inc.notified) continue; // ne notifier le retour que si on avait alerté
    sent += await sendPush({
      title: '✅ Domo — rétabli',
      body: recoveryMessage(inc),
      tag: `ok:${key}`,
      severity: 'info',
      url: '/reglages'
    });
  }
  return sent;
}
