# Kriee

## Déploiement (même stack que Kanots)

1. **Supabase** : nouveau projet → SQL Editor → coller `sql/schema.sql` → Run.
   Ensuite Authentication > Providers, active Email (magic link).
2. **Clés** : Project Settings > API → copier `Project URL` et `anon public key` dans `js/supabase-client.js`.
3. **Vercel** : importer ce dossier comme site statique (pas de build step nécessaire), déployer.
4. **DNS Namecheap** : pointer le domaine choisi vers Vercel.

## Ce qui est fonctionnel
- Grille de lots en direct avec compte à rebours et ticker de clôtures imminentes
- Page lot avec pose d'enchère en temps réel (Supabase Realtime), anti-sniping 3 min, historique
- Calcul du prix acheteur : prix marteau + 18% frais + TVA 21% sur les frais (vendeur payé au marteau, 0 frais)
- Dépôt de lot vendeur → statut `draft` → à faire passer en `live` manuellement (modération) le jour J

## Reste à faire avant un vrai lancement
- Panneau admin pour faire passer les lots de `draft` → `scheduled` → `live` et vérifier l'identité vendeur/acheteur
- Paiement (Stripe) séquestre jusqu'à livraison/signature de l'acte de vente
- Upload d'images réel (Supabase Storage) — actuellement `cover_image_url` en texte simple
- CGV / mentions légales / statut juridique de l'intermédiation (courtage vs commissaire-priseur)
