/* Handler Web Push — importé par le service worker généré (vite-pwa, via
 * workbox.importScripts). Additif : ne touche pas au cache/offline existant.
 * Affiche l'alerte Domo et ouvre/focus l'app au clic. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Domo', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Domo';
  const options = {
    body: data.body || '',
    tag: data.tag || 'domo-alert',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
