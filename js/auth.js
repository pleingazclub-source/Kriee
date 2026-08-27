// Gère l'affichage "Se connecter" / "Déconnexion" dans le header, sur toutes les pages.
// Nécessite que supabase-client.js soit chargé avant ce script.

async function initAuthNav() {
  const navLogin = document.getElementById('nav-login');
  if (!navLogin) return;

  function removeAdminLink() {
    const existing = document.getElementById('nav-admin-link');
    if (existing) existing.remove();
  }

  let renderGen = 0;
  async function render(session) {
    const gen = ++renderGen;

    if (session) {
      navLogin.textContent = `Déconnexion (${session.user.email})`;
      navLogin.href = '#';
      navLogin.onclick = async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signOut();
        location.href = 'index.html';
      };

      const { data: profile } = await supabaseClient.from('profiles').select('is_admin').eq('id', session.user.id).single();
      if (gen !== renderGen) return; // une exécution plus récente a pris le relais, on abandonne celle-ci
      removeAdminLink();
      if (profile && profile.is_admin) {
        const link = document.createElement('a');
        link.id = 'nav-admin-link';
        link.href = 'admin.html';
        link.textContent = 'Modération';
        navLogin.parentNode.insertBefore(link, navLogin);
      }
    } else {
      navLogin.textContent = 'Se connecter';
      navLogin.href = 'connexion.html';
      navLogin.onclick = null;
      removeAdminLink();
    }
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  render(session);

  supabaseClient.auth.onAuthStateChange((_event, newSession) => render(newSession));
}

initAuthNav();
