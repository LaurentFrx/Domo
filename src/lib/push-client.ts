/**
 * Activation des alertes Web Push côté navigateur (PWA installée).
 *
 * ⚠️ vite-pwa (avec SvelteKit) n'auto-enregistre PAS le service worker généré
 * (`/sw.js`) : on l'enregistre donc EXPLICITEMENT ici (ensureServiceWorker). Sans
 * SW actif, `pushManager.subscribe()` est impossible et `navigator.serviceWorker.
 * ready` reste bloqué à l'infini — c'était la cause du « rien ne se passe ».
 *
 * Le handler `push` est greffé sur le SW via static/push-sw.js (importScripts).
 * Ici on gère permission → enregistrement SW → souscription → envoi au serveur.
 * 100 % tolérant : non compatible / permission refusée → état clair, jamais de jet.
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

/**
 * Garantit un service worker ACTIF. vite-pwa ne l'enregistre pas tout seul ici,
 * donc on l'enregistre explicitement, puis on attend son activation (borné pour
 * ne jamais bloquer indéfiniment).
 */
async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  let reg = (await navigator.serviceWorker.getRegistration()) ?? null;
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (e) {
      console.error('[push] enregistrement du service worker échoué:', e);
      return null;
    }
  }
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((res) => setTimeout(res, 8000)) // garde-fou anti-blocage
  ]);
  return (await navigator.serviceWorker.getRegistration()) ?? reg;
}

export async function pushStatus(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    // getRegistration (et NON .ready, qui bloque tant qu'aucun SW n'existe).
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'disabled';
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
    const reg = await ensureServiceWorker();
    if (!reg) return 'error';
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
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
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
