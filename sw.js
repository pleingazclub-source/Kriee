// Service worker Kriee — gère la réception des notifications push et le clic dessus.
// Doit être servi à la racine du site (même niveau qu'index.html) pour couvrir toutes les pages.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Kriee', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Kriee';
  const options = {
    body: data.body || '',
    icon: 'img/logo-mark.png',
    badge: 'img/logo-mark.png',
    data: { link: data.link || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(link) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});
