// ---------- Données de démonstration (utilisées tant que Supabase n'est pas connecté) ----------
const DEMO_LOTS = [
  {
    id: 'demo-1', title: 'Voilier CNSO Samouraï Mk2 — 1979', category_flag: 'V', category_slug: 'voile',
    region: 'Var — Saint-Mandrier-sur-Mer', current_price: 8200, bid_increment: 200,
    ends_at: new Date(Date.now() + 1000 * 60 * 42).toISOString(), image: 'linear-gradient(135deg,#2C6E8E,#0E2233)'
  },
  {
    id: 'demo-2', title: 'Semi-rigide 5,20m + moteur Yamaha 60cv', category_flag: 'S', category_slug: 'semi-rigide',
    region: 'Bouches-du-Rhône — La Ciotat', current_price: 4100, bid_increment: 100,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 5).toISOString(), image: 'linear-gradient(135deg,#B8935A,#0E2233)'
  },
  {
    id: 'demo-3', title: 'Winchs Harken + jeu de voiles First 30', category_flag: 'E', category_slug: 'equipement',
    region: 'Hérault — Sète', current_price: 650, bid_increment: 25,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 22).toISOString(), image: 'linear-gradient(135deg,#C7401F,#0E2233)'
  },
  {
    id: 'demo-4', title: 'Vedette Bénéteau Antares 6 — moteur inboard révisé', category_flag: 'M', category_slug: 'moteur',
    region: 'Var — Toulon', current_price: 15600, bid_increment: 300,
    ends_at: new Date(Date.now() + 1000 * 60 * 60 * 3).toISOString(), image: 'linear-gradient(135deg,#2C6E8E,#0E2233)'
  },
];

let activeFilter = 'all';
let lots = [];

async function loadLots() {
  const isConfigured = !SUPABASE_URL.includes('TON-PROJET');
  if (!isConfigured) {
    lots = DEMO_LOTS;
    render();
    return;
  }

  const { data, error } = await supabaseClient
    .from('lots_with_buyer_price')
    .select('*, categories(slug, flag_code)')
    .in('status', ['live', 'scheduled'])
    .order('ends_at', { ascending: true });

  if (error) {
    console.error(error);
    lots = DEMO_LOTS;
  } else {
    lots = data.map(l => ({
      id: l.id,
      title: l.title,
      category_flag: l.categories?.flag_code || '·',
      category_slug: l.categories?.slug || 'equipement',
      region: l.region,
      current_price: l.current_price,
      bid_increment: l.bid_increment,
      ends_at: l.ends_at,
      image: l.cover_image_url ? `url(${l.cover_image_url})` : 'linear-gradient(135deg,#2C6E8E,#0E2233)',
    }));
  }
  render();

  // Temps réel : recharge quand une enchère ou un lot change
  supabaseClient.channel('public:lots')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lots' }, loadLots)
    .subscribe();
}

function render() {
  renderTicker();
  renderGrid();
}

function renderTicker() {
  const track = document.getElementById('ticker-track');
  const soon = [...lots].sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  const items = soon.map(l => `<span class="ticker__item">⚑ <strong>${l.title}</strong> — clôture dans ${formatCountdown(l.ends_at)} — enchère actuelle ${formatEUR(l.current_price)}</span>`);
  track.innerHTML = items.join('') + items.join(''); // dupliqué pour boucle continue
}

function renderGrid() {
  const grid = document.getElementById('lots');
  const filtered = activeFilter === 'all' ? lots : lots.filter(l => l.category_slug === activeFilter);

  if (filtered.length === 0) {
    grid.innerHTML = `<p style="grid-column:1/-1; color:#5A6772;">Aucun lot dans cette catégorie pour l'instant.</p>`;
    return;
  }

  grid.innerHTML = filtered.map(l => `
    <a class="lot-card" href="lot.html?id=${l.id}">
      <div class="lot-card__media" style="background-image:${l.image}">
        <span class="lot-card__flag">${l.category_flag}</span>
        <span class="lot-card__timer" data-ends="${l.ends_at}">${formatCountdown(l.ends_at)}</span>
      </div>
      <div class="lot-card__body">
        <h3 class="lot-card__title">${l.title}</h3>
        <p class="lot-card__meta">${l.region}</p>
        <div class="lot-card__price-row">
          <span>
            <span class="lot-card__price-label">Enchère actuelle</span><br>
            <span class="lot-card__price">${formatEUR(l.current_price)}</span>
          </span>
          <span class="lot-card__price-label">+${formatEUR(l.bid_increment)} min.</span>
        </div>
      </div>
    </a>
  `).join('');
}

// Filtres
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    chip.setAttribute('aria-pressed', 'true');
    activeFilter = chip.dataset.filter;
    renderGrid();
  });
});

// Rafraîchit les compteurs chaque seconde sans recharger les données
setInterval(() => {
  document.querySelectorAll('[data-ends]').forEach(el => {
    el.textContent = formatCountdown(el.dataset.ends);
  });
  renderTicker();
}, 1000);

loadLots();
