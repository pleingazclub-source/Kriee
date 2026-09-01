// ---------- Données de démonstration (utilisées tant que Supabase n'est pas connecté) ----------
const DEMO_LOTS = [
  {
    id: 'demo-1', title: 'Voilier CNSO Samouraï Mk2 — 1979', category_flag: 'V', category_slug: 'voile',
    region: 'PACA', port_location: 'Saint-Mandrier-sur-Mer', current_price: 8200, bid_increment: 200,
    ends_at: new Date(Date.now() + 1000 * 60 * 42).toISOString(), image: 'linear-gradient(135deg,#2C6E8E,#0E2233)',
    view_count: 748, favorite_count: 34,
  },
  {
    id: 'demo-2', title: 'Semi-rigide 5,20m + moteur Yamaha 60cv', category_flag: 'S', category_slug: 'semi-rigide',
    region: 'PACA', port_location: 'La Ciotat', current_price: 4100, bid_increment: 100,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 5).toISOString(), image: 'linear-gradient(135deg,#B8935A,#0E2233)',
    view_count: 312, favorite_count: 12,
  },
  {
    id: 'demo-3', title: 'Winchs Harken + jeu de voiles First 30', category_flag: 'E', category_slug: 'equipement',
    region: 'Occitanie', port_location: 'Sète', current_price: 650, bid_increment: 25,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 22).toISOString(), image: 'linear-gradient(135deg,#C7401F,#0E2233)',
    view_count: 156, favorite_count: 5,
  },
  {
    id: 'demo-4', title: 'Vedette Bénéteau Antares 6 — moteur inboard révisé', category_flag: 'M', category_slug: 'moteur',
    region: 'PACA', port_location: 'Toulon', current_price: 15600, bid_increment: 300,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 3).toISOString(), image: 'linear-gradient(135deg,#2C6E8E,#0E2233)',
    view_count: 521, favorite_count: 28,
  },
];

let activeFilter = 'all';
let activeRegion = 'all';
let activeCity = 'all';
let searchQuery = '';
let sortBy = 'ending-soon';
let userCoords = null; // { lat, lng } une fois la géolocalisation acceptée
let myFavoriteIds = new Set();
let lots = [];

// Coordonnées approximatives par région — faute de géocoder chaque port individuellement pour l'instant.
// Précision suffisante pour classer "proche / loin" à l'échelle du Sud de la France, pas pour une distance exacte.
const REGION_COORDS = {
  PACA: { lat: 43.55, lng: 6.5 },
  Occitanie: { lat: 43.6, lng: 3.9 },
  Corse: { lat: 42.05, lng: 9.1 },
};

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceForLot(l) {
  if (!userCoords) return null;
  if (l.lat != null && l.lng != null) return haversineKm(userCoords, { lat: l.lat, lng: l.lng });
  const coords = REGION_COORDS[l.region];
  if (!coords) return null;
  return haversineKm(userCoords, coords);
}

async function loadMyFavoriteIds() {
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');
  if (!isConfigured) return;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { myFavoriteIds = new Set(); return; }
  const { data } = await supabaseClient.from('favorites').select('lot_id').eq('user_id', session.user.id);
  myFavoriteIds = new Set((data || []).map(f => f.lot_id));
}

async function loadLots() {
  await loadMyFavoriteIds();
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');
  if (!isConfigured) {
    lots = DEMO_LOTS;
    render();
    return;
  }

  const { data, error } = await supabaseClient
    .from('lots_with_buyer_price')
    .select('*, categories(slug, flag_code, label)')
    .in('status', ['live', 'scheduled'])
    .order('ends_at', { ascending: true });

  if (error) {
    console.error(error);
    lots = DEMO_LOTS;
  } else {
    lots = data.map(l => ({
      id: l.id,
      title: l.title,
      description: l.description || '',
      category_label: l.categories?.label || '',
      specs: l.specs || {},
      category_flag: l.categories?.flag_code || '·',
      category_slug: l.categories?.slug || 'equipement',
      equipment_subtype: l.specs?.general?.["Type d'équipement"] || null,
      region: l.region,
      port_location: l.port_location,
      current_price: l.current_price,
      bid_increment: l.bid_increment,
      ends_at: l.ends_at,
      image: l.cover_image_url ? `url(${l.cover_image_url})` : 'linear-gradient(135deg,#2C6E8E,#0E2233)',
      lat: l.lat,
      lng: l.lng,
      view_count: l.view_count ?? 0,
      favorite_count: l.favorite_count ?? 0,
    }));
  }
  render();

  // Temps réel : recharge quand une enchère ou un lot change
  supabaseClient.channel('public:lots')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lots' }, loadLots)
    .subscribe();
}

function render() {
  if (document.getElementById('ticker-track')) renderTicker();
  if (document.getElementById('city-select')) populateCityFilter();
  if (document.getElementById('lots')) renderGrid();
  if (document.getElementById('trending-grid')) renderTrending();
}

function populateCityFilter() {
  const select = document.getElementById('city-select');
  const cities = [...new Set(lots.map(l => l.port_location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  const current = select.value;
  select.innerHTML = '<option value="all">Toutes les villes</option>' + cities.map(c => `<option value="${c}">${c}</option>`).join('');
  if (cities.includes(current)) select.value = current; // conserve la sélection si elle est toujours valide après un rechargement
}

function renderTicker() {
  const track = document.getElementById('ticker-track');
  const soon = [...lots].sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  const items = soon.map(l => `<span class="ticker__item">⚑ <strong>${l.title}</strong> — clôture dans ${formatCountdown(l.ends_at)} — enchère actuelle ${formatEUR(l.current_price)}</span>`);
  track.innerHTML = items.join('') + items.join(''); // dupliqué pour boucle continue
}

function lotCardHTML(l, opts = {}) {
  const dist = opts.showDistance ? distanceForLot(l) : null;
  const isFav = myFavoriteIds.has(l.id);
  return `
    <a class="lot-card" href="lot.html?id=${l.id}">
      <div class="lot-card__media" style="background-image:${l.image}">
        <span class="lot-card__flag">${l.category_flag}</span>
        <button type="button" class="card-heart ${isFav ? 'card-heart--active' : ''}" data-lot-id="${l.id}" title="Ajouter aux favoris">${isFav ? '♥' : '♡'}</button>
        <span class="lot-card__timer" data-ends="${l.ends_at}">${formatCountdown(l.ends_at)}</span>
      </div>
      <div class="lot-card__body">
        <h3 class="lot-card__title">${l.title}</h3>
        <p class="lot-card__meta">${l.port_location ? `${l.port_location} — ` : ''}${l.region}${dist !== null ? `<span class="lot-card__distance">≈ ${Math.round(dist)} km</span>` : ''}</p>
        <div class="lot-card__price-row">
          <span>
            <span class="lot-card__price-label">Enchère actuelle</span><br>
            <span class="lot-card__price">${formatEUR(l.current_price)}</span>
          </span>
          <span class="lot-card__price-label">+${formatEUR(l.bid_increment)} min.</span>
        </div>
      </div>
    </a>
  `;
}

function renderGrid() {
  const grid = document.getElementById('lots');
  // "voile" et "moteur" remontent aussi les équipements dont le sous-type correspond
  // (ex. un winch tagué "Voile / gréement" apparaît en filtrant "Voile", même si sa catégorie
  // principale reste "equipement") — pas d'équivalent pour "semi-rigide", qui reste strict.
  const equipmentSubtypeMatch = { voile: 'Voile / gréement', moteur: 'Moteur' };
  let filtered = activeFilter === 'all' ? lots : lots.filter(l =>
    l.category_slug === activeFilter ||
    (equipmentSubtypeMatch[activeFilter] && l.category_slug === 'equipement' && l.equipment_subtype === equipmentSubtypeMatch[activeFilter])
  );

  if (activeRegion !== 'all') {
    filtered = filtered.filter(l => l.region === activeRegion);
  }
  if (activeCity !== 'all') {
    filtered = filtered.filter(l => l.port_location === activeCity);
  }

  if (searchQuery.trim()) {
    // Texte combiné (titre, région, port, catégorie, description, et toutes les valeurs des
    // caractéristiques — marque, modèle, année, etc.) plutôt que 3 champs seulement.
    // Recherche mot par mot (chaque mot doit apparaître quelque part, dans n'importe quel ordre)
    // au lieu d'exiger que toute la requête corresponde à une phrase exacte — sinon chercher
    // "voilier bénéteau" ne trouvait jamais rien si ces deux mots n'étaient pas côte à côte.
    const words = searchQuery.trim().toLowerCase().split(/\s+/);
    filtered = filtered.filter(l => {
      const specsText = Object.values(l.specs || {})
        .flatMap(section => Object.values(section || {}))
        .join(' ');
      const haystack = [l.title, l.region, l.port_location, l.category_label, l.description, specsText]
        .join(' ').toLowerCase();
      return words.every(w => haystack.includes(w));
    });
  }

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'price-asc') return a.current_price - b.current_price;
    if (sortBy === 'price-desc') return b.current_price - a.current_price;
    if (sortBy === 'proximity' && userCoords) {
      const da = distanceForLot(a), db = distanceForLot(b);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    }
    return new Date(a.ends_at) - new Date(b.ends_at); // ending-soon (défaut)
  });

  const countEl = document.getElementById('results-count');
  if (countEl) countEl.textContent = `${filtered.length} lot${filtered.length > 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    grid.innerHTML = `<p style="grid-column:1/-1; color:#5A6772;">Aucun lot ne correspond à ta recherche.</p>`;
    return;
  }

  grid.innerHTML = filtered.map(l => lotCardHTML(l, { showDistance: sortBy === 'proximity' })).join('');
}

function renderTrending() {
  const grid = document.getElementById('trending-grid');
  if (!grid) return;
  const top = [...lots]
    .sort((a, b) => ((b.view_count ?? 0) + (b.favorite_count ?? 0) * 3) - ((a.view_count ?? 0) + (a.favorite_count ?? 0) * 3))
    .slice(0, 3);
  grid.innerHTML = top.length
    ? top.map(l => lotCardHTML(l)).join('')
    : `<p style="grid-column:1/-1; color:#5A6772;">Pas encore assez de données pour afficher les tendances.</p>`;
}

// Filtres univers
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    chip.setAttribute('aria-pressed', 'true');
    activeFilter = chip.dataset.filter;
    renderGrid();
  });
});

// Recherche texte + tri (uniquement présents sur la page de recherche)
const searchInput = document.getElementById('search-input');
if (searchInput) {
  // Préremplit depuis ?q=... si on arrive via la barre de recherche de l'accueil (ex. index.html)
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam) {
    searchInput.value = qParam;
    searchQuery = qParam;
  }
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderGrid();
  });
}

const sortSelect = document.getElementById('sort-select');
if (sortSelect) {
  sortSelect.addEventListener('change', (e) => {
    sortBy = e.target.value;
    if (sortBy === 'proximity' && !userCoords) requestGeolocation();
    else renderGrid();
  });
}

const regionSelect = document.getElementById('region-select');
if (regionSelect) {
  regionSelect.addEventListener('change', (e) => {
    activeRegion = e.target.value;
    renderGrid();
  });
}

const citySelect = document.getElementById('city-select');
if (citySelect) {
  citySelect.addEventListener('change', (e) => {
    activeCity = e.target.value;
    renderGrid();
  });
}

const proximityBtn = document.getElementById('proximity-btn');
if (proximityBtn) {
  proximityBtn.addEventListener('click', () => requestGeolocation());
}

const resetBtn = document.getElementById('reset-filters');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    activeFilter = 'all';
    activeRegion = 'all';
    activeCity = 'all';
    searchQuery = '';
    sortBy = 'ending-soon';
    userCoords = null;
    document.getElementById('search-input').value = '';
    document.getElementById('region-select').value = 'all';
    if (document.getElementById('city-select')) document.getElementById('city-select').value = 'all';
    document.getElementById('sort-select').value = 'ending-soon';
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    document.querySelector('.chip[data-filter="all"]').setAttribute('aria-pressed', 'true');
    const status = document.getElementById('proximity-status');
    if (status) status.textContent = '';
    renderGrid();
  });
}

function requestGeolocation() {
  const status = document.getElementById('proximity-status');
  if (!navigator.geolocation) {
    if (status) status.textContent = 'Géolocalisation non disponible sur ce navigateur.';
    return;
  }
  if (status) status.textContent = 'Localisation en cours...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      sortBy = 'proximity';
      if (sortSelect) sortSelect.value = 'proximity';
      if (status) status.textContent = 'Triée par proximité (précis quand le lot a une adresse géocodée, approximatif sinon).';
      renderGrid();
    },
    () => {
      if (status) status.textContent = 'Localisation refusée ou indisponible.';
    }
  );
}

// Rafraîchit les compteurs chaque seconde sans recharger les données
setInterval(() => {
  document.querySelectorAll('[data-ends]').forEach(el => {
    el.textContent = formatCountdown(el.dataset.ends);
  });
  if (document.getElementById('ticker-track')) renderTicker();
}, 1000);

// Cœur de favori sur les vignettes — clic géré par délégation (les cartes sont regénérées à chaque rendu)
async function handleCardHeartClick(e) {
  const btn = e.target.closest('.card-heart');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { location.href = 'connexion.html'; return; }

  const lotId = btn.dataset.lotId;
  const isFav = myFavoriteIds.has(lotId);

  btn.disabled = true;
  const { error } = isFav
    ? await supabaseClient.from('favorites').delete().eq('user_id', session.user.id).eq('lot_id', lotId)
    : await supabaseClient.from('favorites').insert({ user_id: session.user.id, lot_id: lotId });
  btn.disabled = false;

  if (error) { alert('Erreur : ' + error.message); return; }

  if (isFav) { myFavoriteIds.delete(lotId); btn.classList.remove('card-heart--active'); btn.textContent = '♡'; }
  else { myFavoriteIds.add(lotId); btn.classList.add('card-heart--active'); btn.textContent = '♥'; }
}

document.getElementById('lots')?.addEventListener('click', handleCardHeartClick);
document.getElementById('trending-grid')?.addEventListener('click', handleCardHeartClick);

loadLots();
