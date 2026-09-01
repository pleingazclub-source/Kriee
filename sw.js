// Service worker Kriee — gère la réception des notifications push et le clic dessus.
// Doit être servi à la racine du site (même niveau qu'index.html) pour couvrir toutes les pages.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Kriee', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Kriee';
  const options = {
    body: data.body || '',
    icon: 'img/icon-192.png',
    badge: 'img/icon-192.png',
    image: data.image || undefined, // photo du lot, quand disponible — bien plus reconnaissable qu'un simple texte
    vibrate: [120, 60, 120],
    // Regroupe les notifications d'un même type sur un même lot (ex. plusieurs "nouvelle
    // enchère" sur le même bateau) au lieu d'empiler indéfiniment — mais garde séparées les
    // notifications de types différents sur ce même lot (ex. "dépassé" reste visible à côté
    // de "nouvelle enchère").
    tag: data.type && data.link ? `${data.type}:${data.link}` : undefined,
    renotify: true,
    data: { link: data.link || '/' },
    actions: data.link ? [{ action: 'open', title: 'Voir sur Kriee' }] : [],
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
