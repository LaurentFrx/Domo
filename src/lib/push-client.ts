/**
 * Activation des alertes Web Push côté navigateur (PWA installée).
 *
 * Le service worker est celui de vite-pwa (registerType autoUpdate) ; on y greffe
 * le handler `push` via static/push-sw.js (importScripts). Ici on gère seulement
 * l'abonnement : permission → souscription PushManager → envoi au serveur.
 *
 * 100 % tolérant : navigateur non compatible / permission refusée → on renvoie un
 * état clair sans jamais jeter. iOS exige une PWA installée (écran d'accueil) et
 * un geste utilisateur pour la permission — d'où le bouton dédié dans Réglages.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type PushState = 'unsupported' | 'denied' | 'enabled' | 'disabled' | 'error';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function pushStatus(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'enabled' : 'disabled';
  } catch {
    return 'disabled';
  }
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'disabled';
    const res = await fetch('/api/push/subscribe');
    const { vapidPublicKey } = (await res.json()) as { vapidPublicKey: string | null };
    if (!vapidPublicKey) return 'error';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource
      });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub)
    });
    return 'enabled';
  } catch (e) {
    console.error('[push] activation échouée:', e);
    return 'error';
  }
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unsubscribe: true, endpoint: sub.endpoint })
      });
      await sub.unsubscribe();
    }
    return 'disabled';
  } catch {
    return 'error';
  }
}
