// Gère le menu "Se connecter" / menu utilisateur déroulant, sur toutes les pages.
// Nécessite que supabase-client.js soit chargé avant ce script.

async function initAuthNav() {
  const navLogin = document.getElementById('nav-login');
  const userMenu = document.getElementById('user-menu');
  if (!navLogin || !userMenu) return;

  const dropdown = document.getElementById('user-menu-dropdown');
  const toggle = document.getElementById('user-menu-toggle');
  const label = document.getElementById('user-menu-label');
  const nameEl = document.getElementById('user-menu-name');
  const emailEl = document.getElementById('user-menu-email');
  const adminLink = document.getElementById('user-menu-admin-link');
  const activiteBadge = document.getElementById('user-menu-activite-badge');
  const logoutBtn = document.getElementById('user-menu-logout');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdown.classList.remove('open'));

  logoutBtn.addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    location.href = 'index.html';
  });

  // Compteur de notifications non lues, affiché sur "Mon activité" dans ce menu déroulant —
  // même donnée que les badges par sous-onglet de compte.html, mais visible depuis n'importe
  // quelle page sans avoir à ouvrir le compte.
  async function refreshActiviteBadge(userId) {
    if (!activiteBadge) return;
    const { count } = await supabaseClient
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);
    activiteBadge.textContent = count > 9 ? '9+' : String(count || 0);
    activiteBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  let renderGen = 0;
  async function render(session) {
    const gen = ++renderGen;

    if (session) {
      navLogin.style.display = 'none';
      userMenu.style.display = 'inline-block';

      const { data: profile } = await supabaseClient
        .from('profiles')
        .select('is_admin, full_name, pseudo')
        .eq('id', session.user.id)
        .single();

      if (gen !== renderGen) return; // une exécution plus récente a pris le relais, on abandonne celle-ci

      const displayName = profile?.pseudo || profile?.full_name || session.user.email;
      label.textContent = displayName;
      nameEl.textContent = displayName;
      emailEl.textContent = session.user.email;
      adminLink.style.display = (profile && profile.is_admin) ? 'block' : 'none';
      refreshActiviteBadge(session.user.id);
    } else {
      navLogin.href = 'connexion.html';
      navLogin.style.display = 'inline-block';
      userMenu.style.display = 'none';
      dropdown.classList.remove('open');
    }
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  render(session);

  supabaseClient.auth.onAuthStateChange((_event, newSession) => render(newSession));
}

initAuthNav();
