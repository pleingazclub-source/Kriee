const params = new URLSearchParams(location.search);
const lotId = params.get('id') || 'demo-1';

// Même lot de démo que sur l'accueil, avec specs et historique fictifs pour prévisualisation
const DEMO_LOT = {
  id: 'demo-1',
  title: 'Voilier CNSO Samouraï Mk2 — 1979',
  region: 'Var — Saint-Mandrier-sur-Mer',
  description: "Voilier de croisière côtière, coque en bon état, gréement révisé en 2024. Vendu avec remorque routière. Visible sur rendez-vous à Saint-Mandrier-sur-Mer.",
  year_built: 1979,
  length_m: 7.6,
  engine_hours: null,
  category_flag: 'V',
  category_slug: 'voile',
  current_price: 8200,
  bid_increment: 200,
  ends_at: new Date(Date.now() + 1000 * 60 * 42).toISOString(),
  image: 'linear-gradient(135deg,#2C6E8E,#0E2233)',
  specs: {
    general: { 'Marque': 'CNSO', 'Type': 'Samouraï Mk2', 'Longueur': '7,6 m', 'Largeur': '2,5 m', 'Matériau': 'Polyester', 'Nombre de couchettes': '4', 'Année de construction': '1979' },
    moteur: { 'Type de moteur': 'Hors-bord', 'Marque moteur': 'Yamaha', 'Puissance (ch)': '8', 'Carburant': 'Essence', 'Heures moteur': '340' },
    navigation: { 'GPS': '✓', 'VHF': '✓', 'Compas': '✓', 'Loch/speedomètre': '✓' },
    greement: { 'Nombre de mâts': '1', 'Matériau du mât': 'Aluminium', 'Nombre de voiles': '3', 'État des voiles': 'Bon', 'Grand-voile': '✓', 'Génois': '✓', 'Spi': '✓' },
    documents: ['Acte de francisation', 'Dernier rapport de visite technique'],
  },
  bids: [
    { amount: 8200, created_at: new Date(Date.now() - 1000 * 60 * 4).toISOString(), bidder: 'J.****' },
    { amount: 8000, created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(), bidder: 'M.****' },
    { amount: 7500, created_at: new Date(Date.now() - 1000 * 60 * 40).toISOString(), bidder: 'A.****' },
  ]
};

let currentLot = null;

let channelSubscribed = false;

async function loadLot() {
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');

  if (!isConfigured || lotId.startsWith('demo')) {
    currentLot = DEMO_LOT;
    renderLot();
    return;
  }

  const { data: lot, error } = await supabaseClient
    .from('lots_with_buyer_price')
    .select('*, categories(flag_code, slug)')
    .eq('id', lotId)
    .single();

  if (error) { console.error(error); currentLot = DEMO_LOT; renderLot(); return; }

  const { data: bids } = await supabaseClient
    .from('bids')
    .select('amount, created_at, is_auto_bid, profiles(pseudo)')
    .eq('lot_id', lotId)
    .order('amount', { ascending: false })
    .limit(20);

  currentLot = {
    ...lot,
    category_flag: lot.categories?.flag_code || '·',
    category_slug: lot.categories?.slug || 'equipement',
    bids: (bids || []).map(b => ({ amount: b.amount, created_at: b.created_at, is_auto_bid: b.is_auto_bid, bidder: b.profiles?.pseudo || 'Enchérisseur anonyme' })),
  };
  renderLot();

  // L'abonnement temps réel ne doit être créé qu'une seule fois : loadLot() est elle-même
  // le callback rappelé à chaque événement, donc recréer le canal ici provoquerait une
  // tentative de réabonnement sur un canal déjà actif — et une erreur "after subscribe()".
  if (!channelSubscribed) {
    channelSubscribed = true;
    supabaseClient.channel(`lot:${lotId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bids', filter: `lot_id=eq.${lotId}` }, loadLot)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lots', filter: `id=eq.${lotId}` }, loadLot)
      .subscribe();
  }
}

function renderLot() {
  const l = currentLot;
  document.getElementById('page-title').textContent = `${l.title} — Kriee`;
  document.getElementById('view-count').textContent = `👁 ${l.view_count ?? 0}`;
  renderGallery(l);
  document.getElementById('lot-title').textContent = l.title;
  document.getElementById('lot-region').textContent = l.region;
  document.getElementById('lot-description').textContent = l.description || '';

  document.getElementById('lot-specs').innerHTML = `
    ${l.year_built ? `<tr><td>Année</td><td>${l.year_built}</td></tr>` : ''}
    ${l.length_m ? `<tr><td>Longueur</td><td>${l.length_m} m</td></tr>` : ''}
    ${l.engine_hours ? `<tr><td>Heures moteur</td><td>${l.engine_hours} h</td></tr>` : ''}
    <tr><td>Palier d'enchère</td><td>${formatEUR(l.bid_increment)}</td></tr>
  `;

  document.getElementById('bid-current').textContent = formatEUR(l.current_price);
  document.getElementById('bid-timer').textContent = formatCountdown(l.ends_at);

  const minBid = l.current_price + l.bid_increment;
  document.getElementById('bid-amount').min = minBid;
  document.getElementById('bid-amount').value = minBid;
  document.getElementById('bid-min-hint').textContent = `Minimum : ${formatEUR(minBid)}`;

  document.getElementById('one-boat-note').style.display = l.category_slug !== 'equipement' ? 'block' : 'none';

  renderBreakdown(minBid);
  renderHistory();
  renderSpecTabs(l.specs || {});

  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (!session) return;
    if (!checkOwnLot(session.user.id)) {
      const leading = checkLeadingStatus(session.user.id);
      if (!leading) checkProfileComplete(session.user.id);
    }
  });
}

function renderGallery(l) {
  const media = document.getElementById('lot-media');
  const thumbs = document.getElementById('lot-thumbs');
  const images = l.images && l.images.length ? l.images : (l.cover_image_url ? [l.cover_image_url] : []);

  if (images.length) {
    media.style.backgroundImage = `url('${images[0]}')`;
  } else {
    media.style.backgroundImage = l.image || 'linear-gradient(135deg,#2C6E8E,#0E2233)';
  }
  media.style.backgroundSize = 'cover';
  media.style.backgroundPosition = 'center';

  thumbs.innerHTML = images.map((url, i) => `<img src="${url}" class="${i === 0 ? 'active' : ''}" data-url="${url}">`).join('');
  thumbs.querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => {
      media.style.backgroundImage = `url('${img.dataset.url}')`;
      media.style.backgroundSize = 'cover';
      media.style.backgroundPosition = 'center';
      thumbs.querySelectorAll('img').forEach(i => i.classList.remove('active'));
      img.classList.add('active');
    });
  });

  const videoWrap = document.getElementById('lot-video-wrap');
  videoWrap.innerHTML = l.video_url ? `<video src="${l.video_url}" controls></video>` : '';
}

const SPEC_TAB_LABELS = {
  general: 'Général',
  moteur: 'Moteur & électricité',
  navigation: 'Navigation & électronique',
  greement: 'Gréement',
  securite: 'Sécurité & équipement extérieur',
  documents: 'Documents',
};

function renderSpecTabs(specs) {
  const tabsEl = document.getElementById('spec-tabs');
  const panelsEl = document.getElementById('spec-panels');
  const keys = Object.keys(SPEC_TAB_LABELS).filter(k => specs[k] && (Array.isArray(specs[k]) ? specs[k].length : Object.keys(specs[k]).length));

  if (keys.length === 0) {
    tabsEl.innerHTML = '';
    panelsEl.innerHTML = '';
    return;
  }

  tabsEl.innerHTML = keys.map((k, i) => `
    <button class="spec-tab" role="tab" data-tab="${k}" aria-selected="${i === 0}">${SPEC_TAB_LABELS[k]}</button>
  `).join('');

  panelsEl.innerHTML = keys.map((k, i) => `
    <div class="spec-panel ${i === 0 ? 'active' : ''}" data-panel="${k}">
      ${renderSpecPanelContent(k, specs[k])}
    </div>
  `).join('');

  tabsEl.querySelectorAll('.spec-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      tabsEl.querySelectorAll('.spec-tab').forEach(t => t.setAttribute('aria-selected', 'false'));
      tab.setAttribute('aria-selected', 'true');
      panelsEl.querySelectorAll('.spec-panel').forEach(p => p.classList.remove('active'));
      panelsEl.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });
}

function renderSpecPanelContent(key, value) {
  if (key === 'documents') {
    return `<ul class="doc-list">${value.map(doc => `<li>📄 ${doc}</li>`).join('')}</ul>`;
  }
  const rows = Object.entries(value).map(([label, val]) => `<tr><td>${label}</td><td>${val}</td></tr>`).join('');
  return `<table class="spec-table">${rows}</table>`;
}

function renderBreakdown(amount) {
  const b = computeBuyerPrice(amount);
  const isAuto = document.getElementById('bid-mode-auto')?.checked;
  document.getElementById('price-breakdown').innerHTML = `
    <div class="price-breakdown__row"><span>${isAuto ? 'Ton plafond' : 'Ta mise'}</span><span>${formatEUR(b.hammerPrice)}</span></div>
    <div class="price-breakdown__row"><span>Frais de vente (18%)</span><span>${formatEUR(b.feeHT)}</span></div>
    <div class="price-breakdown__row"><span>TVA sur les frais (21%)</span><span>${formatEUR(b.feeVAT)}</span></div>
    <div class="price-breakdown__row price-breakdown__row--total"><span>Total maximum si tu gagnes</span><span>${formatEUR(b.total)}</span></div>
  `;
}

function renderHistory() {
  const rows = currentLot.bids.map(b => `
    <div class="bid-history__row">
      <span>${b.bidder}${b.is_auto_bid ? ' <span style="color:#5A6772;">(auto)</span>' : ''}</span>
      <span>${formatEUR(b.amount)}</span>
    </div>
  `).join('');
  document.getElementById('bid-history').innerHTML = rows || '<p style="color:#5A6772;">Aucune enchère pour l\'instant — soyez le premier.</p>';
}

document.getElementById('bid-amount').addEventListener('input', (e) => {
  const val = Number(e.target.value) || 0;
  renderBreakdown(val);
});

function updateBidModeUI() {
  const isAuto = document.getElementById('bid-mode-auto').checked;
  document.getElementById('bid-amount').setAttribute('aria-label', isAuto ? 'Ton plafond maximum' : 'Montant de ton enchère');
  document.getElementById('bid-mode-hint').textContent = isAuto
    ? "C'est ton plafond maximum, jamais visible des autres — on enchérit pour toi automatiquement, par palier, jusqu'à ce montant. Le prix affiché ne monte que si un autre acheteur te dépasse réellement."
    : 'Ton enchère devient immédiatement le prix affiché, visible de tous.';
  renderBreakdown(Number(document.getElementById('bid-amount').value) || 0);
}
document.getElementById('bid-mode-normal').addEventListener('change', updateBidModeUI);
document.getElementById('bid-mode-auto').addEventListener('change', updateBidModeUI);

document.getElementById('bid-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById('bid-amount').value);
  const commitment = document.getElementById('bid-commitment').checked;
  const feedback = document.getElementById('bid-feedback');
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');

  if (!commitment) {
    feedback.textContent = "Coche la case d'engagement pour enchérir.";
    feedback.style.color = 'var(--buoy)';
    return;
  }

  if (currentLot && new Date(currentLot.ends_at).getTime() <= Date.now()) {
    feedback.textContent = 'Cette enchère est terminée — plus aucune enchère n\'est possible.';
    feedback.style.color = 'var(--buoy)';
    return;
  }

  if (!isConfigured || lotId.startsWith('demo')) {
    feedback.textContent = 'Démo : connecte Supabase (js/supabase-client.js) pour enchérir réellement.';
    feedback.style.color = 'var(--mistral)';
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    feedback.textContent = 'Connecte-toi pour enchérir.';
    feedback.style.color = 'var(--buoy)';
    return;
  }

  const isAuto = document.getElementById('bid-mode-auto').checked;
  const { error } = await supabaseClient.rpc('place_bid', { p_lot_id: lotId, p_amount: amount, p_commitment: commitment, p_is_auto: isAuto });
  if (error) {
    feedback.textContent = error.message;
    feedback.style.color = 'var(--buoy)';
  } else {
    feedback.textContent = isAuto
      ? 'Plafond enregistré — on enchérit pour toi automatiquement si besoin.'
      : 'Enchère enregistrée.';
    feedback.style.color = 'var(--mistral)';
    document.getElementById('bid-commitment').checked = false;
  }
});

// ---------- Mise en scène des 3 dernières secondes : sons synthétisés (aucun fichier audio requis) ----------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('click', () => { try { getAudioCtx(); } catch (e) {} }, { once: true });

function playTick() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

function playGavel() {
  try {
    const ctx = getAudioCtx();
    // deux coups de marteau : thud grave, façon "toc-toc" du commissaire-priseur
    [0, 0.2].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(130, ctx.currentTime + delay);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + delay + 0.16);
      gain.gain.setValueAtTime(0.55, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.22);
    });
  } catch (e) {}
}

function flashScreen(strong) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const overlay = document.getElementById('flash-overlay');
  if (!overlay) return;
  overlay.style.opacity = strong ? '0.85' : '0.45';
  setTimeout(() => { overlay.style.opacity = '0'; }, strong ? 200 : 100);
}

let lastEndsAtTracked = null;
let firedThresholds = new Set();
let closingResolved = false;
let hasInitializedClosing = false;

function tickClosingSequence() {
  if (!currentLot) return;
  const panel = document.querySelector('.bid-panel');
  const banner = document.getElementById('adjuge-banner');
  const endsAt = currentLot.ends_at;

  if (endsAt !== lastEndsAtTracked) {
    // La clôture a changé (nouvelle prolongation anti-sniping, ou premier chargement) : on repart à zéro.
    lastEndsAtTracked = endsAt;
    firedThresholds = new Set();
    closingResolved = false;
    panel.classList.remove('closing-tick');
    banner.style.display = 'none';
    document.getElementById('bid-amount').disabled = false;
    document.querySelector('#bid-form button[type="submit"]').disabled = false;
  }

  const diff = new Date(endsAt).getTime() - Date.now();

  if (diff > 0 && diff <= 3000) {
    panel.classList.add('closing-tick');
    const secondsLeft = Math.ceil(diff / 1000);
    if (!firedThresholds.has(secondsLeft)) {
      firedThresholds.add(secondsLeft);
      if (hasInitializedClosing) { playTick(); flashScreen(false); }
    }
  } else if (diff <= 0 && !closingResolved) {
    closingResolved = true;
    panel.classList.remove('closing-tick');
    if (hasInitializedClosing) { playGavel(); flashScreen(true); }
    banner.style.display = 'flex';
    document.getElementById('bid-amount').disabled = true;
    document.querySelector('#bid-form button[type="submit"]').disabled = true;
  } else if (diff > 3000) {
    panel.classList.remove('closing-tick');
  }

  hasInitializedClosing = true; // pas de son/flash sur le tout premier rendu de la page
}

setInterval(() => {
  if (currentLot) {
    document.getElementById('bid-timer').textContent = formatCountdown(currentLot.ends_at);
    tickClosingSequence();
  }
}, 1000);

// ---------- Favoris & compteur de vues ----------
let isFavorited = false;
let viewCounted = false;

function checkOwnLot(userId) {
  if (!currentLot || currentLot.seller_id !== userId) return false;
  document.getElementById('bid-form-wrap').style.display = 'none';
  document.getElementById('own-lot-note').style.display = 'block';
  return true;
}

// Tant que l'utilisateur est en tête, son plafond s'affiche en clair à la place du formulaire —
// dès qu'il est dépassé, le formulaire (champ + case d'engagement) réapparaît automatiquement.
function checkLeadingStatus(userId) {
  const isLeading = currentLot && currentLot.leading_bidder_id === userId;
  document.getElementById('bid-form-wrap').style.display = isLeading ? 'none' : 'block';
  const note = document.getElementById('own-ceiling-note');
  note.style.display = isLeading ? 'block' : 'none';
  if (isLeading) {
    const hasHiddenCeiling = currentLot.leading_max_amount > currentLot.current_price;
    note.innerHTML = hasHiddenCeiling
      ? `✓ Tu es en tête. <strong>Ton plafond automatique : ${formatEUR(currentLot.leading_max_amount)}</strong><br><span style="font-size:0.78rem; font-weight:400; color:#1D6B3E;">On enchérit pour toi si quelqu'un te dépasse, jusqu'à ce montant.</span>`
      : `✓ Tu es en tête à <strong>${formatEUR(currentLot.current_price)}</strong>.`;
  }
  return isLeading;
}

async function checkProfileComplete(userId) {
  const { data } = await supabaseClient.from('profiles').select('full_name, phone, city, pseudo').eq('id', userId).single();
  const complete = data && data.full_name && data.phone && data.city && data.pseudo;
  if (!complete) {
    const btn = document.getElementById('bid-form').querySelector('button[type="submit"]');
    document.getElementById('bid-amount').disabled = true;
    btn.disabled = true;
    document.getElementById('bid-feedback').innerHTML = '⚠️ <a href="compte.html" style="color:var(--buoy);">Complète ton profil</a> (nom, pseudo, téléphone, ville) avant de pouvoir enchérir.';
    document.getElementById('bid-feedback').style.color = 'var(--buoy)';
  }
}

async function initFavoriteAndViews() {
  if (lotId.startsWith('demo')) return; // pas de compteurs réels en mode démo

  if (!viewCounted) {
    viewCounted = true;
    supabaseClient.rpc('increment_view_count', { p_lot_id: lotId }).then(async ({ error }) => {
      if (error) { console.error('increment_view_count a échoué :', error); return; }
      const { data } = await supabaseClient.from('lots').select('view_count').eq('id', lotId).single();
      if (data) {
        document.getElementById('view-count').textContent = `👁 ${data.view_count}`;
        if (currentLot) currentLot.view_count = data.view_count;
      }
    });
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    const { data } = await supabaseClient
      .from('favorites')
      .select('lot_id')
      .eq('user_id', session.user.id)
      .eq('lot_id', lotId)
      .maybeSingle();
    isFavorited = !!data;
    updateFavoriteUI();
  }
}

function updateFavoriteUI() {
  const btn = document.getElementById('favorite-btn');
  btn.textContent = isFavorited ? '♥' : '♡';
  btn.setAttribute('aria-pressed', String(isFavorited));
  btn.classList.toggle('favorite-btn--active', isFavorited);
}

document.getElementById('favorite-btn').addEventListener('click', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { location.href = 'connexion.html'; return; }

  const btn = document.getElementById('favorite-btn');
  btn.disabled = true;

  let mutationError = null;
  if (isFavorited) {
    const { error } = await supabaseClient.from('favorites').delete().eq('user_id', session.user.id).eq('lot_id', lotId);
    mutationError = error;
    if (!error) isFavorited = false;
  } else {
    const { error } = await supabaseClient.from('favorites').insert({ user_id: session.user.id, lot_id: lotId });
    mutationError = error;
    if (!error) isFavorited = true;
  }

  btn.disabled = false;

  if (mutationError) {
    alert('Erreur lors de la mise à jour du favori : ' + mutationError.message);
    return;
  }

  updateFavoriteUI();
});

initFavoriteAndViews();

loadLot();
