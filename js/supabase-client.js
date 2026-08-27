// Config Supabase — remplace par les clés de ton projet (Project Settings > API)
const SUPABASE_URL = 'https://ugyglrozoythkdmlitsc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YIE6KLjDJZucMEBg5kBINw_QEisVdBz';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Modèle économique : frais acheteur uniquement (le vendeur touche le prix marteau intégral)
const BUYER_PREMIUM_RATE = 0.18; // frais de vente
const VAT_RATE = 0.21;           // TVA sur les frais de vente uniquement

function computeBuyerPrice(hammerPrice) {
  const feeHT = hammerPrice * BUYER_PREMIUM_RATE;
  const feeVAT = feeHT * VAT_RATE;
  const total = hammerPrice + feeHT + feeVAT;
  return {
    hammerPrice,
    feeHT: Math.round(feeHT * 100) / 100,
    feeVAT: Math.round(feeVAT * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

function formatEUR(amount) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount);
}

function formatCountdown(endsAt) {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return 'Clôturé';
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days} j ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Upload un fichier vers le bucket lot-media, sous le dossier de l'utilisateur connecté. Retourne l'URL publique.
async function uploadLotMedia(file, userId) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabaseClient.storage.from('lot-media').upload(path, file);
  if (error) throw error;
  const { data } = supabaseClient.storage.from('lot-media').getPublicUrl(path);
  return data.publicUrl;
}

// Géocodage best-effort d'une adresse texte via Nominatim (OpenStreetMap, gratuit, aucune clé API requise).
// Volontairement non bloquant : délai plafonné à 3s, ne lève jamais d'erreur — retourne simplement null en cas d'échec.
// Pour un usage à plus gros volume, envisager un géocodeur payant (Google Maps, Mapbox) avec mise en cache côté serveur.
async function geocodeAddress(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    return null;
  } catch (err) {
    return null; // timeout, réseau indisponible, réponse invalide... jamais bloquant pour l'appelant
  }
}
