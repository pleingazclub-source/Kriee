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

async function loadLot() {
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');

  if (!isConfigured || lotId.startsWith('demo')) {
    currentLot = DEMO_LOT;
    renderLot();
    return;
  }

  const { data: lot, error } = await supabaseClient
    .from('lots_with_buyer_price')
    .select('*, categories(flag_code)')
    .eq('id', lotId)
    .single();

  if (error) { console.error(error); currentLot = DEMO_LOT; renderLot(); return; }

  const { data: bids } = await supabaseClient
    .from('bids')
    .select('amount, created_at, profiles(full_name)')
    .eq('lot_id', lotId)
    .order('amount', { ascending: false })
    .limit(20);

  currentLot = {
    ...lot,
    category_flag: lot.categories?.flag_code || '·',
    bids: (bids || []).map(b => ({ amount: b.amount, created_at: b.created_at, bidder: b.profiles?.full_name || 'Enchérisseur' })),
  };
  renderLot();

  supabaseClient.channel(`lot:${lotId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bids', filter: `lot_id=eq.${lotId}` }, loadLot)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lots', filter: `id=eq.${lotId}` }, loadLot)
    .subscribe();
}

function renderLot() {
  const l = currentLot;
  document.getElementById('page-title').textContent = `${l.title} — Kriee`;
  document.getElementById('lot-media').style.background = l.image || 'linear-gradient(135deg,#2C6E8E,#0E2233)';
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

  renderBreakdown(minBid);
  renderHistory();
  renderSpecTabs(l.specs || {});
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
  document.getElementById('price-breakdown').innerHTML = `
    <div class="price-breakdown__row"><span>Prix marteau (si adjugé)</span><span>${formatEUR(b.hammerPrice)}</span></div>
    <div class="price-breakdown__row"><span>Frais de vente (18%)</span><span>${formatEUR(b.feeHT)}</span></div>
    <div class="price-breakdown__row"><span>TVA sur les frais (21%)</span><span>${formatEUR(b.feeVAT)}</span></div>
    <div class="price-breakdown__row price-breakdown__row--total"><span>Total acheteur</span><span>${formatEUR(b.total)}</span></div>
  `;
}

function renderHistory() {
  const rows = currentLot.bids.map(b => `
    <div class="bid-history__row">
      <span>${b.bidder}</span>
      <span>${formatEUR(b.amount)}</span>
    </div>
  `).join('');
  document.getElementById('bid-history').innerHTML = rows || '<p style="color:#5A6772;">Aucune enchère pour l\'instant — soyez le premier.</p>';
}

document.getElementById('bid-amount').addEventListener('input', (e) => {
  const val = Number(e.target.value) || 0;
  renderBreakdown(val);
});

document.getElementById('bid-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById('bid-amount').value);
  const feedback = document.getElementById('bid-feedback');
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');

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

  const { error } = await supabaseClient.rpc('place_bid', { p_lot_id: lotId, p_amount: amount });
  if (error) {
    feedback.textContent = error.message;
    feedback.style.color = 'var(--buoy)';
  } else {
    feedback.textContent = 'Enchère enregistrée.';
    feedback.style.color = 'var(--mistral)';
  }
});

setInterval(() => {
  if (currentLot) document.getElementById('bid-timer').textContent = formatCountdown(currentLot.ends_at);
}, 1000);

loadLot();
