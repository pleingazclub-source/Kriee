// Gère l'activation/désactivation des notifications push web, et la préférence email.
// Appelé depuis compte.html (section "Notifications" du profil). Nécessite supabase-client.js
// déjà chargé avant ce script.

const VAPID_PUBLIC_KEY = 'BKruMtTXn3ndrPuw-CiBhtgFOF3VT1lZYhGyUiI1Y5Ww7zJNJ9LaTmEgyb_bN8SwQlFLdX7OM196fGzQFyaIgFg';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function subscribeToPush(userId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error("Les notifications push ne sont pas supportées par ce navigateur.");
  }
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error("Permission refusée — active les notifications dans les réglages du navigateur si tu changes d'avis.");
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = subscription.toJSON();
  const { error } = await supabaseClient.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth_key: json.keys.auth,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

async function unsubscribeFromPush(userId) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await supabaseClient.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    await subscription.unsubscribe();
  }
}
