# Kriee

Plateforme d'enchères nautiques entre particuliers (bateaux et accastillage), Sud de la France.

## Déploiement (même stack que Kanots)

1. **Supabase** : nouveau projet → SQL Editor → coller `sql/schema.sql` → Run.
   Ensuite Authentication > Providers, active Email (magic link).
2. **Clés** : Project Settings > API → copier `Project URL` et `anon public key` dans `js/supabase-client.js`.
3. **Vercel** : importer ce dossier comme site statique (pas de build step nécessaire), déployer.
4. **DNS** : domaine `kriee.fr` acheté, à pointer vers Vercel.
5. **Resend** : domaine `kriee.fr` vérifié (SPF/DKIM/DMARC), utilisé pour l'envoi des emails transactionnels.
6. **Edge Function `notify`** : à déployer séparément (voir §Notifications ci-dessous) — gère l'envoi email + push.

## ⚠️ Piège technique à connaître absolument

La vue `lots_with_buyer_price` (`select l.*, ...`) **fige la liste des colonnes au moment de sa création**. Chaque fois qu'une colonne est ajoutée à `lots` après coup, il faut relancer :
```sql
drop view if exists public.lots_with_buyer_price;
create view public.lots_with_buyer_price as
select l.*,
  round(l.current_price * 0.18, 2) as buyer_fee_ht,
  round(l.current_price * 0.18 * 0.21, 2) as buyer_fee_vat,
  round(l.current_price + (l.current_price * 0.18 * 1.21), 2) as buyer_total_price
from public.lots l;
```
Un simple `create or replace view` ne suffit PAS. C'est déjà arrivé plusieurs fois (dernière fois : colonnes `checklist`/`expertise_*` jamais reprises par la vue après leur ajout — corrigé via `fix-vue-lots-buyer-price.sql`).

## Ce qui est fonctionnel

**Enchères**
- Grille de lots en direct, compte à rebours, ticker de clôtures imminentes
- Page lot avec enchère en temps réel (Supabase Realtime), historique
- Deux modes : normale (montant = prix affiché) et automatique (plafond privé, système surenchérit pour l'utilisateur)
- Anti-sniping : +3 min si enchère dans les 3 dernières minutes
- Un acheteur ne peut être en tête que sur un seul bateau à la fois (accastillage libre)
- Confirmation avant validation d'une enchère (évite les erreurs de saisie)
- Calcul du prix acheteur : prix marteau + frais de vente calculés par tranche sur le prix marteau final, comme l'impôt (18% jusqu'à 25k€, 12% de 25k à 100k€, 8% au-delà) + TVA 21% sur les frais (vendeur payé au marteau, 0 frais)
- Navigation photo gauche/droite sur la fiche lot

**Dépôt et modération**
- Wizard de dépôt en 7 étapes (titre/catégorie, localisation, prix/durée, caractéristiques, équipements à bord, description/docs, récapitulatif) — écrans allégés, un thème par écran
- 9 catégories (voile, moteur, semi-rigide, catamaran, jet-ski, pêche & travail, péniche & habitable, remorque, équipement) — toute nouvelle catégorie non "équipement" hérite automatiquement des règles bateau (checklist, seuil d'expertise, une enchère à la fois)
- Upload réel des photos/vidéo/documents vers Supabase Storage
- Checklist de transparence (déclaration vendeur, gratuite) sur tous les bateaux
- **Rapport d'expertise obligatoire au-delà de 5000€ de prix de départ** — fournissable avant ou après l'enchère ; si après, bloque la révélation des coordonnées tant qu'il n'est pas fourni **et validé par la modération**
- Statuts : `draft` → `live` (après modération) → `sold`/`unsold`/`cancelled`/`deleted`
- Remise en vente d'un lot invendu (durée fixe 7 jours, historique d'enchères précédent purgé proprement)
- Suppression définitive par le vendeur d'un lot refusé
- Panneau admin par onglets : Vue d'ensemble (revenu), Lots (modération + filtres), Expertises (validation), Utilisateurs, Signalés (désistements) — badges de compteur en direct sur chaque onglet

**Après l'enchère**
- Vendeur accepte/refuse, acheteur confirme — coordonnées révélées uniquement une fois les deux d'accord (et l'expertise validée si applicable)
- Historique acheteur / strikes : 3 désistements après acceptation vendeur bloquent les enchères (levable par un admin)
- Modèle "vendu en l'état" — pas de visite organisée par la plateforme (risque de contournement acheteur/vendeur identifié et écarté), tout repose sur photos/vidéos/description/checklist/expertise

**Notifications**
- Table `notifications` + Edge Function `notify` (Deno, Supabase) envoyant email (Resend) et push web (VAPID) selon les préférences de chaque utilisateur
- Déclenché sur : enchère dépassée, nouvelle enchère reçue (vendeur), enchère remportée, lot vendu/invendu, lot approuvé/refusé, expertise à valider/validée/refusée, vente acceptée/confirmée, avertissement avant purge de compte inactif
- Badges de notification (façon leboncoin) : sur le menu déroulant du profil (toutes pages) et sur les sous-onglets de "Mon activité" — se marquent comme lus au clic. Mapping type de notif → catégorie centralisé dans `js/supabase-client.js` (`NOTIF_TYPE_TO_SUBTAB`), partagé par `auth.js` et `compte.html` pour rester cohérent
- Service worker (`sw.js`) + abonnement push géré depuis "Mon compte"

**Compte utilisateur**
- Onglets Profil / Mon activité, avec sous-onglets Favoris / Enchères / Lots en vente (filtre En cours·Terminés·Tous) / Achats
- Toutes les lignes de tableau sont cliquables (pas que le bouton "Voir")

**RGPD / légal**
- `mentions-legales.html` et `confidentialite.html` — infos réelles de PG CLUB (SASU, SIREN 988 182 903, RCS Aix-en-Provence)
- Polices auto-hébergées (`css/fonts.css`) — pas de bandeau cookies nécessaire tant qu'aucun traceur non essentiel n'est ajouté
- Pied de page email conforme (identification expéditeur, lien politique de confidentialité)
- Purge automatique quotidienne des comptes inactifs depuis 2 ans (email d'alerte 30 jours avant, anonymisation)

**Page d'accueil / UX**
- `comment-ca-marche.html` — page dédiée (frais, enchères, dépôt, vérification, clôture, visite, modération, notifications)
- Header : bouton "Déposer un lot" mis en avant + barre de recherche (ordre inspiré leboncoin), header minimal pendant le dépôt

## Reste à faire avant un vrai lancement

- **`sql/schema.sql` a pris du retard sur la base réellement en ligne** : plusieurs migrations (notifications, checklist/expertise, catégories, frais dégressifs...) ont été appliquées directement via l'éditeur SQL Supabase, sans jamais être reportées dans ce fichier source. Il ne reflète donc plus fidèlement l'état actuel — à réconcilier un jour, par exemple via `supabase db dump` sur le projet live.

- **Paiement Lemonway** : architecture posée (`sales.payment_status`, `profiles.lemonway_wallet_id`/`lemonway_kyc_status`, deux Edge Functions scaffoldées) mais jamais activée, faute de compte Lemonway actif. Chaque vendeur devra avoir son propre compte Lemonway + KYC validé.
- **Médiateur de la consommation** : encart à compléter dans `mentions-legales.html` (choisir un médiateur agréé, ex. CM2C)
- **DPA (contrats de sous-traitance RGPD)** à signer avec Supabase, Resend, Lemonway
- **Registre des traitements** RGPD (modèle CNIL, art. 30) — pas encore rédigé
- **Validation juridique globale** par un avocat avant lancement réel (statut de l'intermédiation, CGV/CGU, clause de non-contournement déjà présente mais à faire relire)
- **Favicon** : jamais résolu proprement — le logo actuel perd tout son détail en dessous de 32px, une version simplifiée dédiée reste à faire
- **BIMI** (icône Gmail à côté de l'expéditeur) : nécessite DMARC en mode strict (`p=quarantine`/`reject`, actuellement `p=none`) + un certificat VMC payant — chantier à part, pas commencé
- Idées UX en réserve (non implémentées) : catégories cliquables sous le header, icône favoris directement visible dans le nav, recherches sauvegardées
