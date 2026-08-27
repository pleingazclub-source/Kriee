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
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 24) return `${Math.floor(h / 24)} j`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
