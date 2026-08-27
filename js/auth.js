// Gère l'affichage "Se connecter" / "Déconnexion" dans le header, sur toutes les pages.
// Nécessite que supabase-client.js soit chargé avant ce script.

async function initAuthNav() {
  const navLogin = document.getElementById('nav-login');
  if (!navLogin) return;

  function render(session) {
    if (session) {
      navLogin.textContent = `Déconnexion (${session.user.email})`;
      navLogin.href = '#';
      navLogin.onclick = async (e) => {
        e.preventDefault();
        await supabaseClient.auth.signOut();
        location.href = 'index.html';
      };
    } else {
      navLogin.textContent = 'Se connecter';
      navLogin.href = 'connexion.html';
      navLogin.onclick = null;
    }
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  render(session);

  supabaseClient.auth.onAuthStateChange((_event, newSession) => render(newSession));
}

initAuthNav();
