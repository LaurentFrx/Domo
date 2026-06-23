/**
 * Web Push — canal d'alerte immédiat, même app fermée (PWA iOS installée).
 *
 * VAPID + chiffrement gérés par la lib `web-push`. Les abonnements sont stockés
 * dans `data/push-subscriptions.json` (best-effort ; on purge ceux que le service
 * de push déclare expirés/inconnus — 404/410). Aucun secret côté client : seule
 * la clé PUBLIQUE VAPID est exposée (nécessaire pour s'abonner).
 *
 * Tolérant : si les clés VAPID ne sont pas configurées, sendPush est un no-op
 * (l'app continue de fonctionner ; le bandeau in-app reste le canal de secours).
 */
import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SUBS_FILE = path.resolve(process.cwd(), 'data', 'push-subscriptions.json');

type Sub = webpush.PushSubscription;
let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT || 'mailto:laurent@feroux.fr';
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export function publicKey(): string | null {
  return env.VAPID_PUBLIC_KEY || null;
}

function loadSubs(): Sub[] {
  try {
    const arr = JSON.parse(readFileSync(SUBS_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSubs(subs: Sub[]): void {
  try {
    writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (e) {
    console.error('[push] sauvegarde abonnements échouée:', (e as Error).message);
  }
}

export function addSubscription(sub: Sub): void {
  if (!sub || !sub.endpoint) return;
  const subs = loadSubs();
  if (!subs.some((x) => x.endpoint === sub.endpoint)) {
    subs.push(sub);
    saveSubs(subs);
  }
}

export function removeSubscription(endpoint: string): void {
  saveSubs(loadSubs().filter((s) => s.endpoint !== endpoint));
}

export function subscriptionCount(): number {
  return loadSubs().length;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  severity?: 'critical' | 'warning' | 'info';
  url?: string;
}

/** Envoie une notification à tous les abonnés. Renvoie le nb d'envois réussis. */
export async function sendPush(payload: PushPayload): Promise<number> {
  if (!ensureConfigured()) return 0;
  const subs = loadSubs();
  if (subs.length === 0) return 0;
  const body = JSON.stringify(payload);
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, body, { TTL: 600, urgency: 'high' });
        ok++;
      } catch (e: unknown) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410)
          removeSubscription(s.endpoint); // abonnement mort
        else console.error('[push] envoi échoué:', (e as Error).message);
      }
    })
  );
  return ok;
}
