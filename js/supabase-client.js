// Config Supabase — remplace par les clés de ton projet (Project Settings > API)
const SUPABASE_URL = 'https://ugyglrozoythkdmlitsc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YIE6KLjDJZucMEBg5kBINw_QEisVdBz';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Modèle économique : frais acheteur uniquement (le vendeur touche le prix marteau intégral).
// Frais dégressifs calculés PAR TRANCHE sur le prix marteau final, comme l'impôt sur le revenu —
// chaque tranche du montant est facturée à son propre taux, pas un taux unique appliqué à tout
// le montant dès qu'un palier est atteint. Ex. un lot adjugé à 150 000€ paie 18% sur les premiers
// 25 000€, 12% sur la tranche 25 000-100 000€, et 8% sur le reste au-delà de 100 000€.
const BUYER_FEE_BRACKETS = [
  { upTo: 25000, rate: 0.18 },
  { upTo: 100000, rate: 0.12 },
  { upTo: Infinity, rate: 0.08 },
];
const VAT_RATE = 0.21; // TVA sur les frais de vente uniquement

function buyerFeeHTFromPrice(hammerPrice) {
  let fee = 0;
  let lower = 0;
  for (const bracket of BUYER_FEE_BRACKETS) {
    const upper = Math.min(hammerPrice, bracket.upTo);
    if (upper > lower) fee += (upper - lower) * bracket.rate;
    lower = bracket.upTo;
    if (hammerPrice <= bracket.upTo) break;
  }
  return fee;
}

function computeBuyerPrice(hammerPrice) {
  const feeHT = buyerFeeHTFromPrice(hammerPrice);
  const feeVAT = feeHT * VAT_RATE;
  const total = hammerPrice + feeHT + feeVAT;
  return {
    hammerPrice,
    effectiveRate: hammerPrice > 0 ? feeHT / hammerPrice : 0,
    feeHT: Math.round(feeHT * 100) / 100,
    feeVAT: Math.round(feeVAT * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

function formatEUR(amount) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount);
}

// Format court réutilisé partout où une date/heure doit apparaître dans un tableau (compte,
// modération) — ex. "28 août" ou "28 août 14:30" avec l'heure si demandée.
function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const opts = { day: 'numeric', month: 'short' };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return new Intl.DateTimeFormat('fr-FR', opts).format(new Date(iso));
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

// Associe chaque type de notification au sous-onglet de "Mon activité" concerné. Centralisé ici
// (plutôt que dupliqué dans compte.html et auth.js) pour que le badge du menu déroulant (toutes
// pages) et les badges par sous-onglet (compte.html) comptent toujours exactement la même chose —
// sans ça, une notification d'un type non reconnu (ex. un test manuel) gonfle l'un sans jamais
// apparaître dans l'autre. 'sale_confirmed' est envoyé aussi bien à l'acheteur qu'au vendeur avec
// le même type — rattachée à "achats" par défaut : côté vendeur, l'info reste de toute façon
// visible directement dans "Mes lots en vente".
const NOTIF_TYPE_TO_SUBTAB = {
  outbid: 'encheres',
  auction_won: 'achats',
  sale_accepted: 'achats',
  sale_confirmed: 'achats',
  payment_deadline_soon: 'achats',
  payment_overdue: 'achats',
  lot_sold: 'lots',
  lot_unsold: 'lots',
  lot_approved: 'lots',
  lot_rejected: 'lots',
  new_bid: 'lots',
  expertise_needed: 'lots',
  expertise_approved: 'lots',
  expertise_rejected: 'lots',
};
