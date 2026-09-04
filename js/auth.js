// Gère le menu "Se connecter" / menu utilisateur déroulant, sur toutes les pages.
// Nécessite que supabase-client.js soit chargé avant ce script.

let authNavListenersAttached = false; // évite les écouteurs/abonnements en double si initAuthNav()
                                       // se rejoue (retour bfcache, voir plus bas)

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
  const moderationBadge = document.getElementById('user-menu-moderation-badge');
  const logoutBtn = document.getElementById('user-menu-logout');

  // Compteur de notifications non lues — affiché à la fois sur le bouton fermé (pour être visible
  // sans avoir à ouvrir le menu) et sur "Mon activité" une fois le menu déroulant ouvert. Même
  // donnée, même moteur (applyBadge, voir js/supabase-client.js) que les badges de compte.html.
  async function refreshActiviteBadge(userId) {
    // Même métrique que "Mon activité" sur compte.html (nombre de LOTS distincts concernés par
    // une notification non lue) — pas un comptage de notifications par type, pour que le badge
    // affiché ici, avant même d'ouvrir le compte, corresponde exactement à ce qu'on y retrouve.
    const { data } = await supabaseClient
      .from('notifications')
      .select('lot_id')
      .eq('user_id', userId)
      .is('read_at', null)
      .not('lot_id', 'is', null);
    const count = new Set((data || []).map(n => n.lot_id)).size;
    applyBadge('user-menu-activite-badge', count);
    applyBadge('user-menu-toggle-badge', count);
  }

  // Agrège les 3 files d'attente de modération (lots en attente, expertises à valider, acheteurs
  // signalés) — mêmes feuilles, même moteur (renderBadgeNode/countRows) que le badge "Vue
  // d'ensemble" d'admin.html, pour que "Modération" dans ce menu reflète toujours exactement ce
  // qu'on y retrouve, sans avoir à l'ouvrir d'abord. Les enfants n'ont pas de badgeId (null) : pas
  // de détail par catégorie affiché à cet endroit, seul le total compte ici.
  async function refreshModerationBadge() {
    if (!moderationBadge) return;
    await renderBadgeNode({
      badgeId: 'user-menu-moderation-badge',
      children: [
        { badgeId: null, fetchCount: () => countRows('lots', q => q.eq('status', 'draft')) },
        { badgeId: null, fetchCount: () => countRows('lots', q => q.eq('expertise_status', 'pending')) },
        { badgeId: null, fetchCount: () => countRows('profiles', q => q.gt('buyer_strikes', 0)) },
      ],
    });
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
      if (profile && profile.is_admin) refreshModerationBadge();
      refreshActiviteBadge(session.user.id);
    } else {
      navLogin.href = 'connexion.html';
      navLogin.style.display = 'inline-block';
      userMenu.style.display = 'none';
      dropdown.classList.remove('open');
    }
  }

  if (!authNavListenersAttached) {
    authNavListenersAttached = true;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));

    logoutBtn.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      location.href = 'index.html';
    });

    supabaseClient.auth.onAuthStateChange((_event, newSession) => render(newSession));
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  render(session);
}

initAuthNav();

// Le bouton/geste "retour" restaure souvent la page depuis le cache mémoire du navigateur
// (bfcache) plutôt que de la recharger — sans ce correctif, le badge de notifications reste figé
// à l'état d'avant que tu aies consulté un lot ou une vente. Générique à toutes les pages,
// puisque ce fichier est chargé partout.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) initAuthNav();
});
