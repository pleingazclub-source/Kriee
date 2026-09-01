-- Kriee — schéma Supabase (Postgres)
-- À exécuter dans l'éditeur SQL Supabase, sur un projet neuf.

create extension if not exists "uuid-ossp";

-- ============ PROFILS ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  city text,
  is_seller_verified boolean default false,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
create policy "profils publics en lecture" on public.profiles for select using (true);
create policy "un user modifie son profil" on public.profiles for update using (auth.uid() = id);
create policy "un user crée son profil" on public.profiles for insert with check (auth.uid() = id);

-- ============ CATEGORIES ============
create table public.categories (
  id serial primary key,
  slug text unique not null,
  label text not null,
  flag_code text not null -- code pavillon marine (ex: 'A','B'...) utilisé côté UI
);

insert into public.categories (slug, label, flag_code) values
  ('voile', 'Voile', 'V'),
  ('moteur', 'Moteur', 'M'),
  ('semi-rigide', 'Semi-rigide', 'S'),
  ('catamaran', 'Catamaran', 'C'),
  ('jetski', 'Jet-ski', 'J'),
  ('peche-travail', 'Pêche & travail', 'T'),
  ('habitable', 'Péniche & habitable', 'H'),
  ('remorque', 'Remorque', 'R'),
  ('equipement', 'Équipement & accastillage', 'E');

alter table public.categories enable row level security;
create policy "categories publiques en lecture" on public.categories for select using (true);

-- ============ LOTS (annonces mises en enchère) ============
create table public.lots (
  id uuid primary key default uuid_generate_v4(),
  seller_id uuid references public.profiles(id) not null,
  category_id int references public.categories(id) not null,
  title text not null,
  description text not null,
  region text not null default 'PACA', -- lancement Sud : PACA, Occitanie, Corse
  port_location text,
  year_built int,
  length_m numeric(4,2),
  engine_hours int,
  reserve_price numeric(10,2) not null,
  starting_price numeric(10,2) not null,
  bid_increment numeric(10,2) not null default 100,
  current_price numeric(10,2) not null,
  status text not null default 'draft' check (status in ('draft','scheduled','live','sold','unsold','cancelled','deleted')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  cover_image_url text,
  images text[] default '{}',
  -- Caractéristiques détaillées par onglet (Général / Moteur & électricité / Navigation / Gréement / Documents).
  -- Structure libre : { "general": {"Marque":"...", ...}, "moteur": {...}, "navigation": {...}, "greement": {...}, "documents": ["nom du doc", ...] }
  specs jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index on public.lots (status, ends_at);
create index on public.lots (category_id);
create index on public.lots (region);

alter table public.lots enable row level security;
create policy "lots publiés visibles par tous" on public.lots
  for select using (status in ('scheduled','live','sold','unsold'));
create policy "vendeur voit ses brouillons" on public.lots
  for select using (auth.uid() = seller_id);
create policy "vendeur crée ses lots" on public.lots
  for insert with check (auth.uid() = seller_id);
create policy "vendeur modifie ses lots avant mise en ligne" on public.lots
  -- Autorise aussi le vendeur à corriger/resoumettre ou supprimer lui-même un lot refusé
  -- ('cancelled'), pas seulement un brouillon — le WITH CHECK empêche de sortir vers un
  -- statut arbitraire (ex. 'live', 'sold').
  for update using (auth.uid() = seller_id and status in ('draft', 'cancelled'))
  with check (auth.uid() = seller_id and status in ('draft', 'deleted'));

-- ============ ENCHERES ============
create table public.bids (
  id uuid primary key default uuid_generate_v4(),
  lot_id uuid references public.lots(id) not null,
  bidder_id uuid references public.profiles(id) not null,
  amount numeric(10,2) not null,
  is_auto_bid boolean default false,
  max_auto_amount numeric(10,2),
  commitment_confirmed_at timestamptz,
  created_at timestamptz default now()
);

create index on public.bids (lot_id, amount desc);

alter table public.bids enable row level security;
create policy "encheres visibles par tous" on public.bids for select using (true);
create policy "un user enchérit en son nom" on public.bids
  for insert with check (auth.uid() = bidder_id);

-- ============ FONCTION : poser une enchère (normale ou automatique, engagement explicite, anti-sniping, limite bateaux) ============
-- Deux modes, choisis par l'acheteur à chaque enchère (p_is_auto) :
--  - NORMALE (par défaut) : le montant saisi devient directement le prix affiché, visible de tous — dynamique,
--    on voit le prix monter en direct.
--  - AUTOMATIQUE (optionnelle) : le montant saisi est un plafond privé, jamais visible des autres. Le système
--    surenchérit à la place de l'acheteur, par palier, jusqu'à ce plafond, seulement si un concurrent le dépasse.
-- Dans les deux cas : un enchérisseur déjà en tête ne peut pas remonter sa propre enchère tant que personne
-- ne l'a dépassé ; engagement explicite obligatoire ; anti-sniping (+3 min si enchère dans les 3 dernières
-- minutes) ; un bateau à la fois en tête (l'équipement reste libre).
create or replace function public.place_bid(p_lot_id uuid, p_amount numeric, p_commitment boolean, p_is_auto boolean default false)
returns public.lots
language plpgsql
security definer
as $$
declare
  v_lot public.lots%rowtype;
  v_category_slug text;
  v_new_visible_price numeric;
begin
  select * into v_lot from public.lots where id = p_lot_id for update;

  if v_lot.status <> 'live' then
    raise exception 'Ce lot n''est pas ouvert aux enchères.';
  end if;

  if now() > v_lot.ends_at then
    raise exception 'Cette enchère est terminée.';
  end if;

  if v_lot.seller_id = auth.uid() then
    raise exception 'Tu ne peux pas enchérir sur ton propre lot.';
  end if;

  if not p_commitment then
    raise exception 'Tu dois confirmer ton engagement à payer avant d''enchérir.';
  end if;

  if not coalesce(public.profile_is_complete(auth.uid()), false) then
    raise exception 'Complète ton profil (nom, pseudo, téléphone, ville) dans "Mon compte" avant de pouvoir enchérir.';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and buyer_strikes >= 3) then
    raise exception 'Tes enchères sont temporairement bloquées suite à des désistements répétés après une vente acceptée. Contacte le support pour lever ce blocage.';
  end if;

  if p_amount < v_lot.current_price + v_lot.bid_increment then
    raise exception 'Ton montant doit être d''au moins % €', v_lot.current_price + v_lot.bid_increment;
  end if;

  if v_lot.leading_bidder_id = auth.uid() then
    raise exception 'Tu es déjà le meilleur enchérisseur sur ce lot. Attends qu''un autre acheteur enchérisse avant de remonter.';
  end if;

  select slug into v_category_slug from public.categories where id = v_lot.category_id;

  if v_category_slug <> 'equipement' and exists (
    select 1
    from public.lots l2
    join public.categories c2 on c2.id = l2.category_id
    where l2.status = 'live'
      and l2.ends_at > now()
      and l2.id <> p_lot_id
      and c2.slug <> 'equipement'
      and l2.leading_bidder_id = auth.uid()
  ) then
    raise exception 'Tu es déjà en tête sur un autre bateau. Une seule enchère "bateau" active à la fois — termine ou fais-toi dépasser sur celle-ci avant d''en démarrer une autre.';
  end if;

  if p_is_auto then
    -- ---------- Mode automatique : p_amount est un plafond privé ----------
    if v_lot.leading_bidder_id is null then
      v_new_visible_price := v_lot.current_price;
    elsif p_amount > v_lot.leading_max_amount then
      v_new_visible_price := least(p_amount, v_lot.leading_max_amount + v_lot.bid_increment);
    else
      v_new_visible_price := least(v_lot.leading_max_amount, p_amount + v_lot.bid_increment);
    end if;

    insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount, commitment_confirmed_at)
    values (p_lot_id, auth.uid(), least(p_amount, v_new_visible_price), false, p_amount, now());

    if v_lot.leading_bidder_id is not null and v_lot.leading_max_amount >= p_amount then
      insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount)
      values (p_lot_id, v_lot.leading_bidder_id, v_new_visible_price, true, v_lot.leading_max_amount);

      update public.lots
      set current_price = v_new_visible_price,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    else
      update public.lots
      set current_price = v_new_visible_price,
          leading_bidder_id = auth.uid(),
          leading_max_amount = p_amount,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    end if;

  else
    -- ---------- Mode normal : p_amount devient directement le prix affiché ----------
    v_new_visible_price := p_amount;

    insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount, commitment_confirmed_at)
    values (p_lot_id, auth.uid(), p_amount, false, p_amount, now());

    if v_lot.leading_bidder_id is not null and v_lot.leading_max_amount > p_amount then
      -- Un enchérisseur en mode automatique avait un plafond plus haut : il reprend la tête tout seul
      v_new_visible_price := least(v_lot.leading_max_amount, p_amount + v_lot.bid_increment);

      insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount)
      values (p_lot_id, v_lot.leading_bidder_id, v_new_visible_price, true, v_lot.leading_max_amount);

      update public.lots
      set current_price = v_new_visible_price,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    else
      update public.lots
      set current_price = v_new_visible_price,
          leading_bidder_id = auth.uid(),
          leading_max_amount = p_amount,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    end if;
  end if;

  return v_lot;
end;
$$;

-- ============ COLONNES DE LEADER (procuration) — documentées ici pour que le fichier reste fidèle à la base réelle ============
alter table public.lots add column if not exists leading_bidder_id uuid references public.profiles(id);
alter table public.lots add column if not exists leading_max_amount numeric(10,2);

-- ============ VUE : calcul du prix acheteur (frais 18% + TVA 21% sur les frais) ============
-- Reconstruite entièrement (drop + create, pas juste replace) à chaque fois que des colonnes sont
-- ajoutées à "lots" après coup : "l.*" fige la liste des colonnes AU MOMENT de la création de la vue,
-- un simple "create or replace" ne suffit pas à la faire reprendre les nouvelles colonnes.
drop view if exists public.lots_with_buyer_price;
create view public.lots_with_buyer_price as
select
  l.*,
  round(l.current_price * 0.18, 2) as buyer_fee_ht,
  round(l.current_price * 0.18 * 0.21, 2) as buyer_fee_vat,
  round(l.current_price + (l.current_price * 0.18 * 1.21), 2) as buyer_total_price
from public.lots l;

-- ============ CRÉATION AUTOMATIQUE DU PROFIL À L'INSCRIPTION ============
-- Sans ce trigger, un compte peut exister dans auth.users sans ligne correspondante
-- dans public.profiles, ce qui fait échouer toute création de lot (clé étrangère lots.seller_id -> profiles.id).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Rattrapage pour les comptes déjà créés avant ce trigger
insert into public.profiles (id)
select id from auth.users
where id not in (select id from public.profiles)
on conflict (id) do nothing;

-- ============ MODÉRATION & MÉDIAS ============
-- Colonne admin (à activer manuellement pour ton propre compte, voir instructions données à part)
alter table public.profiles add column if not exists is_admin boolean default false;

-- Un admin voit et modifie TOUS les lots, quel que soit leur statut ou leur vendeur
create policy "admin voit tous les lots" on public.lots
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "admin modifie tous les lots" on public.lots
  for update using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Vidéo de présentation (facultative), en plus de cover_image_url et images déjà existants
alter table public.lots add column if not exists video_url text;
-- Motif de refus, visible par le vendeur dans son espace "Mon compte"
alter table public.lots add column if not exists moderation_note text;
-- Coordonnées précises du lot, géocodées à partir de l'adresse saisie par le vendeur (best-effort, peuvent être nulles)
alter table public.lots add column if not exists lat numeric;
alter table public.lots add column if not exists lng numeric;

-- ============ CLÔTURE AUTOMATIQUE DES ENCHÈRES TERMINÉES ============
-- Sans ça, un lot dont ends_at est dépassé reste indéfiniment status='live' tant qu'un admin
-- ne le change pas à la main — ce qui trompe la restriction multi-bateaux, la grille, les stats, etc.
-- pg_cron vérifie toutes les minutes et bascule vers 'sold' (réserve atteinte) ou 'unsold' (sinon).
-- Dans les deux cas, si un enchérisseur était en tête, une vente est créée : le vendeur garde le
-- choix final même quand la réserve n'est pas atteinte (l'acheteur, lui, s'est déjà engagé à payer
-- ce montant en cochant la case au moment de son enchère — son engagement ne dépend pas de la réserve).
create or replace function public.close_expired_auctions()
returns void
language plpgsql
security definer
as $$
declare
  r record;
begin
  for r in select * from public.lots where status = 'live' and ends_at <= now() loop
    update public.lots
    set status = case when r.current_price >= r.reserve_price then 'sold' else 'unsold' end
    where id = r.id;

    if r.leading_bidder_id is not null then
      insert into public.sales (lot_id, seller_id, buyer_id, hammer_price, buyer_total_price)
      values (
        r.id, r.seller_id, r.leading_bidder_id, r.current_price,
        round(r.current_price + (r.current_price * 0.18 * 1.21), 2)
      )
      on conflict (lot_id) do nothing;
    end if;
  end loop;
end;
$$;

-- ============ VENTES : acceptation vendeur, engagement acheteur, coordonnées ============
create table public.sales (
  id uuid primary key default uuid_generate_v4(),
  lot_id uuid references public.lots(id) unique not null,
  seller_id uuid references public.profiles(id) not null,
  buyer_id uuid references public.profiles(id) not null,
  hammer_price numeric(10,2) not null,
  buyer_total_price numeric(10,2) not null,
  seller_accepted boolean,
  buyer_confirmed boolean,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  seller_decision_at timestamptz,
  buyer_decision_at timestamptz,
  created_at timestamptz default now()
);

alter table public.sales enable row level security;
create policy "vendeur et acheteur voient leur vente" on public.sales
  for select using (auth.uid() = seller_id or auth.uid() = buyer_id);

-- Le vendeur accepte ou refuse la vente (RPC plutôt qu'un update direct : évite qu'une des deux
-- parties modifie le champ de décision de l'autre via un appel API détourné)
create or replace function public.seller_respond_to_sale(p_sale_id uuid, p_accept boolean)
returns public.sales
language plpgsql
security definer
as $$
declare v_sale public.sales%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if v_sale.id is null then
    raise exception 'Vente introuvable.';
  end if;
  if v_sale.seller_id <> auth.uid() then
    raise exception 'Tu n''es pas le vendeur de ce lot.';
  end if;

  update public.sales
  set seller_accepted = p_accept,
      seller_decision_at = now(),
      status = case
        when p_accept = false then 'cancelled'
        when p_accept = true and v_sale.buyer_confirmed = true then 'confirmed'
        else status
      end
  where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end;
$$;

create or replace function public.buyer_confirm_sale(p_sale_id uuid, p_confirm boolean)
returns public.sales
language plpgsql
security definer
as $$
declare v_sale public.sales%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if v_sale.id is null then
    raise exception 'Vente introuvable.';
  end if;
  if v_sale.buyer_id <> auth.uid() then
    raise exception 'Tu n''es pas l''acheteur de ce lot.';
  end if;

  update public.sales
  set buyer_confirmed = p_confirm,
      buyer_decision_at = now(),
      status = case
        when p_confirm = false then 'cancelled'
        when p_confirm = true and v_sale.seller_accepted = true then 'confirmed'
        else status
      end
  where id = p_sale_id
  returning * into v_sale;

  return v_sale;
end;
$$;

-- Coordonnées du contre-parti, révélées uniquement une fois la vente confirmée des deux côtés
create or replace function public.get_sale_contact(p_sale_id uuid)
returns table(email text, phone text, full_name text)
language plpgsql
security definer
as $$
declare
  v_sale public.sales%rowtype;
  v_counterpart_id uuid;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.seller_id <> auth.uid() and v_sale.buyer_id <> auth.uid() then
    raise exception 'Accès refusé.';
  end if;
  if v_sale.status <> 'confirmed' then
    raise exception 'Les coordonnées ne sont visibles qu''une fois la vente confirmée par les deux parties.';
  end if;

  v_counterpart_id := case when auth.uid() = v_sale.seller_id then v_sale.buyer_id else v_sale.seller_id end;

  return query
    select u.email::text, p.phone, p.full_name
    from auth.users u
    join public.profiles p on p.id = u.id
    where u.id = v_counterpart_id;
end;
$$;

grant execute on function public.seller_respond_to_sale(uuid, boolean) to authenticated;
grant execute on function public.buyer_confirm_sale(uuid, boolean) to authenticated;
grant execute on function public.get_sale_contact(uuid) to authenticated;

-- ============ REMISE EN VENTE D'UN LOT INVENDU ============
-- Contenu déjà approuvé une première fois, rien n'a changé : repart directement en 'live',
-- pas besoin de repasser par la modération. Reprend la même durée que le cycle précédent.
create or replace function public.relist_lot(p_lot_id uuid)
returns public.lots
language plpgsql
security definer
as $$
declare
  v_lot public.lots%rowtype;
  v_sale public.sales%rowtype;
begin
  select * into v_lot from public.lots where id = p_lot_id for update;

  if v_lot.id is null then
    raise exception 'Lot introuvable.';
  end if;
  if v_lot.seller_id <> auth.uid() then
    raise exception 'Tu n''es pas le vendeur de ce lot.';
  end if;
  if v_lot.status <> 'unsold' then
    raise exception 'Seul un lot invendu peut être remis en vente.';
  end if;

  select * into v_sale from public.sales where lot_id = p_lot_id;
  if v_sale.id is not null and v_sale.status = 'confirmed' then
    raise exception 'Une vente est en cours de finalisation sur ce lot — impossible de le remettre en vente.';
  end if;

  -- Une vente en attente ou annulée n'a plus lieu d'être : on la retire pour libérer le lot
  -- pour un nouveau cycle (la contrainte unique sur sales.lot_id l'exigerait sinon).
  delete from public.sales where lot_id = p_lot_id and status <> 'confirmed';
  -- Le round précédent n'a pas atteint la réserve : ses enchères n'ont plus de valeur contractuelle
  -- (personne n'a rien remporté) — on les efface pour ne pas laisser un historique/"ta mise" trompeur.
  delete from public.bids where lot_id = p_lot_id;

  -- Durée fixe (7 jours) plutôt que dérivée de l'ancien round : évite qu'une fenêtre anormalement
  -- courte (test, bug, anti-sniping jamais déclenché) se reproduise indéfiniment à chaque relist.
  update public.lots
  set status = 'live',
      current_price = starting_price,
      leading_bidder_id = null,
      leading_max_amount = null,
      starts_at = now(),
      ends_at = now() + interval '7 days'
  where id = p_lot_id
  returning * into v_lot;

  return v_lot;
end;
$$;

grant execute on function public.relist_lot(uuid) to authenticated;

-- ============ PROFIL ÉTENDU : civilité, adresse complète, informations entreprise (vendeurs pros) ============
alter table public.profiles add column if not exists civility text check (civility in ('M.', 'Mme', 'Autre'));
alter table public.profiles add column if not exists postal_code text;
alter table public.profiles add column if not exists address text;
alter table public.profiles add column if not exists company_name text;
alter table public.profiles add column if not exists vat_number text;
alter table public.profiles add column if not exists company_website text;

-- ============ PSEUDO PUBLIC ============
-- Affiché aux autres utilisateurs (historique d'enchères, etc.) à la place du nom réel.
-- Le nom complet (profiles.full_name) reste réservé aux échanges post-vente confirmée.
-- Unique pour éviter toute confusion d'identité entre deux comptes (les NULL restent autorisés en multiple).
alter table public.profiles add column if not exists pseudo text unique;

-- ============ PROFIL COMPLET OBLIGATOIRE POUR ENCHÉRIR OU VENDRE ============
-- Sans ça, la révélation de coordonnées en fin de vente n'a rien à révéler.
create or replace function public.profile_is_complete(p_user_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select coalesce(full_name, '') <> '' and coalesce(phone, '') <> '' and coalesce(city, '') <> '' and coalesce(pseudo, '') <> ''
  from public.profiles
  where id = p_user_id;
$$;

-- Bloque le dépôt d'un lot si le profil du vendeur est incomplet (uniquement à la création,
-- pas à une resoumission — le profil était déjà complet la première fois)
create or replace function public.check_seller_profile_complete()
returns trigger
language plpgsql
security definer
as $$
begin
  if not coalesce(public.profile_is_complete(new.seller_id), false) then
    raise exception 'Complète ton profil (nom, téléphone, ville) dans "Mon compte" avant de déposer un lot.';
  end if;
  return new;
end;
$$;

drop trigger if exists on_lot_insert_check_profile on public.lots;
create trigger on_lot_insert_check_profile
  before insert on public.lots
  for each row execute procedure public.check_seller_profile_complete();

-- ============ HISTORIQUE ACHETEUR & "STRIKES" ============
-- Un acheteur qui remporte un lot s'est déjà engagé (case cochée à l'enchère). S'il se désiste
-- ensuite (buyer_confirm_sale à false), ça compte comme un incident. Au 3e, ses enchères sont
-- bloquées jusqu'à levée manuelle par un admin — pas de bannissement définitif automatique.
alter table public.profiles add column if not exists buyer_strikes integer not null default 0;

create or replace function public.handle_buyer_backout()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.buyer_confirmed = false and (old.buyer_confirmed is null or old.buyer_confirmed <> false) then
    update public.profiles set buyer_strikes = buyer_strikes + 1 where id = new.buyer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_buyer_backout on public.sales;
create trigger on_buyer_backout
  after update on public.sales
  for each row execute procedure public.handle_buyer_backout();

-- Fonction utilitaire pour vérifier le statut admin sans provoquer de récursion RLS
-- (une policy sur "profiles" qui interroge "profiles" directement peut boucler ; en passant
-- par une fonction security definer, la vérification s'exécute hors RLS, proprement)
create or replace function public.current_user_is_admin()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create policy "admin modifie tous les profils" on public.profiles
  for update using (public.current_user_is_admin());

-- ============ PAIEMENT RÉEL VIA LEMONWAY (préparation — activé une fois le compte Lemonway obtenu) ============
alter table public.profiles add column if not exists lemonway_wallet_id text;
alter table public.profiles add column if not exists lemonway_kyc_status text default 'none' check (lemonway_kyc_status in ('none','pending','verified','refused'));

alter table public.sales add column if not exists payment_status text default 'unpaid' check (payment_status in ('unpaid','pending','paid','payout_sent','refunded'));
alter table public.sales add column if not exists lemonway_transaction_id text;
alter table public.sales add column if not exists paid_at timestamptz;
alter table public.sales add column if not exists payout_at timestamptz;


-- ============ FAVORIS & COMPTEUR DE VUES ============
alter table public.lots add column if not exists view_count integer not null default 0;
alter table public.lots add column if not exists favorite_count integer not null default 0;

create table public.favorites (
  user_id uuid references public.profiles(id) on delete cascade,
  lot_id uuid references public.lots(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, lot_id)
);
alter table public.favorites enable row level security;
create policy "un user gère ses propres favoris" on public.favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Maintient lots.favorite_count à jour automatiquement à chaque ajout/retrait
create or replace function public.handle_favorite_change()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'INSERT' then
    update public.lots set favorite_count = favorite_count + 1 where id = new.lot_id;
    return new;
  elsif TG_OP = 'DELETE' then
    update public.lots set favorite_count = greatest(favorite_count - 1, 0) where id = old.lot_id;
    return old;
  end if;
end;
$$;

drop trigger if exists on_favorite_change on public.favorites;
create trigger on_favorite_change
  after insert or delete on public.favorites
  for each row execute procedure public.handle_favorite_change();

-- Incrémente le compteur de vues, y compris pour un visiteur non connecté (bypasse la RLS volontairement, rien de sensible)
create or replace function public.increment_view_count(p_lot_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update public.lots set view_count = view_count + 1 where id = p_lot_id;
end;
$$;

grant execute on function public.increment_view_count(uuid) to anon, authenticated;

-- Stockage des photos/vidéos : bucket public en lecture, upload réservé aux comptes connectés
insert into storage.buckets (id, name, public)
values ('lot-media', 'lot-media', true)
on conflict (id) do nothing;

create policy "lecture publique des médias de lots" on storage.objects
  for select using (bucket_id = 'lot-media');
create policy "upload de médias par les comptes connectés" on storage.objects
  for insert with check (bucket_id = 'lot-media' and auth.role() = 'authenticated');
create policy "un user supprime ses propres médias" on storage.objects
  for delete using (bucket_id = 'lot-media' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============ REALTIME ============
alter publication supabase_realtime add table public.bids;
alter publication supabase_realtime add table public.lots;

-- ============================================================
-- Tout ce qui suit a été appliqué directement via l'éditeur SQL Supabase, en plusieurs fois,
-- sans jamais être reporté ici avant cette réconciliation. Reconstitué à l'identique de l'état
-- réellement en ligne — voir le README pour le contexte de chaque bloc.
-- ============================================================

-- ============ CATALOGUE : catégories additionnelles (marché régional) ============
insert into public.categories (slug, label, flag_code) values
  ('catamaran', 'Catamaran', 'C'),
  ('jetski', 'Jet-ski', 'J'),
  ('peche-travail', 'Pêche & travail', 'T'),
  ('habitable', 'Péniche & habitable', 'H'),
  ('remorque', 'Remorque', 'R')
on conflict (slug) do nothing;

-- ============ CHECKLIST DE TRANSPARENCE + EXPERTISE OBLIGATOIRE (>= 5000€) ============
alter table public.lots add column if not exists checklist jsonb default '{}'::jsonb;
alter table public.lots add column if not exists expertise_report_url text;
alter table public.lots add column if not exists expertise_status text check (expertise_status in ('pending', 'approved', 'rejected'));
alter table public.lots add column if not exists expertise_moderation_note text;
alter table public.lots add column if not exists expertise_submitted_at timestamptz;

create or replace function public.lot_requires_expertise(p_lot_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select starting_price >= 5000 from public.lots where id = p_lot_id), false);
$$;

create or replace function public.lot_has_approved_expertise(p_lot_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce((select expertise_status = 'approved' from public.lots where id = p_lot_id), false);
$$;

-- ============ FRAIS ACHETEUR : calcul par tranche (marginal, comme l'impôt), 8-18% ============
-- Ex. un lot adjugé à 150 000€ paie 18% sur les premiers 25 000€, 12% sur 25 000-100 000€,
-- 8% au-delà — pas un taux unique appliqué à tout le montant dès qu'un palier est atteint.
create or replace function public.buyer_fee_ht(p_hammer_price numeric)
returns numeric
language sql
immutable
as $$
  select
    least(p_hammer_price, 25000) * 0.18
    + greatest(least(p_hammer_price, 100000) - 25000, 0) * 0.12
    + greatest(p_hammer_price - 100000, 0) * 0.08;
$$;

-- ============ NOTIFICATIONS (email via Resend + push web) ============
create table public.notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) not null,
  type text not null,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz default now()
);
create index on public.notifications (user_id, created_at desc);
create index on public.notifications (user_id, read_at) where read_at is null;
alter table public.notifications enable row level security;
create policy "un user voit ses notifications" on public.notifications
  for select using (auth.uid() = user_id);
create policy "un user marque ses notifications comme lues" on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email_enabled boolean not null default true,
  push_enabled boolean not null default true
);
alter table public.notification_preferences enable row level security;
create policy "un user gère ses préférences" on public.notification_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.push_subscriptions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
create policy "un user gère ses abonnements push" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.notify_event(p_user_id uuid, p_type text, p_title text, p_body text, p_link text default null)
returns void
language plpgsql
security definer
as $$
begin
  if p_user_id is null then return; end if;
  insert into public.notifications (user_id, type, title, body, link)
  values (p_user_id, p_type, p_title, p_body, p_link);
end;
$$;

-- ============ SALES : date butoir de paiement + statut d'attente d'expertise ============
alter table public.sales add column if not exists confirmed_at timestamptz;
alter table public.sales drop constraint if exists sales_status_check;
alter table public.sales add constraint sales_status_check
  check (status in ('pending', 'awaiting_expertise', 'confirmed', 'cancelled'));

-- ============ PLACE_BID : version finale (+ notifications dépassé / nouvelle enchère) ============
create or replace function public.place_bid(p_lot_id uuid, p_amount numeric, p_commitment boolean, p_is_auto boolean default false)
returns public.lots
language plpgsql
security definer
as $$
declare
  v_lot public.lots%rowtype;
  v_category_slug text;
  v_new_visible_price numeric;
  v_previous_leader uuid;
begin
  select * into v_lot from public.lots where id = p_lot_id for update;
  v_previous_leader := v_lot.leading_bidder_id;

  if v_lot.status <> 'live' then
    raise exception 'Ce lot n''est pas ouvert aux enchères.';
  end if;

  if now() > v_lot.ends_at then
    raise exception 'Cette enchère est terminée.';
  end if;

  if v_lot.seller_id = auth.uid() then
    raise exception 'Tu ne peux pas enchérir sur ton propre lot.';
  end if;

  if not p_commitment then
    raise exception 'Tu dois confirmer ton engagement à payer avant d''enchérir.';
  end if;

  if not coalesce(public.profile_is_complete(auth.uid()), false) then
    raise exception 'Complète ton profil (nom, pseudo, téléphone, ville) dans "Mon compte" avant de pouvoir enchérir.';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and buyer_strikes >= 3) then
    raise exception 'Tes enchères sont temporairement bloquées suite à des désistements répétés après une vente acceptée. Contacte le support pour lever ce blocage.';
  end if;

  if p_amount < v_lot.current_price + v_lot.bid_increment then
    raise exception 'Ton montant doit être d''au moins % €', v_lot.current_price + v_lot.bid_increment;
  end if;

  if v_lot.leading_bidder_id = auth.uid() then
    raise exception 'Tu es déjà le meilleur enchérisseur sur ce lot. Attends qu''un autre acheteur enchérisse avant de remonter.';
  end if;

  select slug into v_category_slug from public.categories where id = v_lot.category_id;

  if v_category_slug <> 'equipement' and exists (
    select 1
    from public.lots l2
    join public.categories c2 on c2.id = l2.category_id
    where l2.status = 'live'
      and l2.ends_at > now()
      and l2.id <> p_lot_id
      and c2.slug <> 'equipement'
      and l2.leading_bidder_id = auth.uid()
  ) then
    raise exception 'Tu es déjà en tête sur un autre bateau. Une seule enchère "bateau" active à la fois — termine ou fais-toi dépasser sur celle-ci avant d''en démarrer une autre.';
  end if;

  if p_is_auto then
    if v_lot.leading_bidder_id is null then
      v_new_visible_price := v_lot.current_price;
    elsif p_amount > v_lot.leading_max_amount then
      v_new_visible_price := least(p_amount, v_lot.leading_max_amount + v_lot.bid_increment);
    else
      v_new_visible_price := least(v_lot.leading_max_amount, p_amount + v_lot.bid_increment);
    end if;

    insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount, commitment_confirmed_at)
    values (p_lot_id, auth.uid(), least(p_amount, v_new_visible_price), false, p_amount, now());

    if v_lot.leading_bidder_id is not null and v_lot.leading_max_amount >= p_amount then
      insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount)
      values (p_lot_id, v_lot.leading_bidder_id, v_new_visible_price, true, v_lot.leading_max_amount);

      update public.lots
      set current_price = v_new_visible_price,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    else
      update public.lots
      set current_price = v_new_visible_price,
          leading_bidder_id = auth.uid(),
          leading_max_amount = p_amount,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    end if;

  else
    v_new_visible_price := p_amount;

    insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount, commitment_confirmed_at)
    values (p_lot_id, auth.uid(), p_amount, false, p_amount, now());

    if v_lot.leading_bidder_id is not null and v_lot.leading_max_amount > p_amount then
      v_new_visible_price := least(v_lot.leading_max_amount, p_amount + v_lot.bid_increment);

      insert into public.bids (lot_id, bidder_id, amount, is_auto_bid, max_auto_amount)
      values (p_lot_id, v_lot.leading_bidder_id, v_new_visible_price, true, v_lot.leading_max_amount);

      update public.lots
      set current_price = v_new_visible_price,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    else
      update public.lots
      set current_price = v_new_visible_price,
          leading_bidder_id = auth.uid(),
          leading_max_amount = p_amount,
          ends_at = case when ends_at - now() < interval '3 minutes' then now() + interval '3 minutes' else ends_at end
      where id = p_lot_id
      returning * into v_lot;
    end if;
  end if;

  if v_previous_leader is not null and v_lot.leading_bidder_id is not null and v_lot.leading_bidder_id <> v_previous_leader then
    perform public.notify_event(
      v_previous_leader, 'outbid',
      'Tu as été dépassé', v_lot.title || ' — nouvelle enchère : ' || v_lot.current_price || ' €',
      'lot.html?id=' || v_lot.id
    );
  end if;

  if v_lot.leading_bidder_id is not null and v_lot.leading_bidder_id is distinct from v_previous_leader then
    perform public.notify_event(
      v_lot.seller_id, 'new_bid',
      'Nouvelle enchère sur ton lot', v_lot.title || ' — ' || v_lot.current_price || ' €',
      'lot.html?id=' || v_lot.id
    );
  end if;

  return v_lot;
end;
$$;

-- ============ CLÔTURE : version finale (frais marginaux + notifications) ============
create or replace function public.close_expired_auctions()
returns void
language plpgsql
security definer
as $$
declare
  r record;
  v_new_status text;
begin
  for r in select * from public.lots where status = 'live' and ends_at <= now() loop
    v_new_status := case when r.current_price >= r.reserve_price then 'sold' else 'unsold' end;

    update public.lots set status = v_new_status where id = r.id;

    if r.leading_bidder_id is not null then
      insert into public.sales (lot_id, seller_id, buyer_id, hammer_price, buyer_total_price)
      values (
        r.id, r.seller_id, r.leading_bidder_id, r.current_price,
        round(r.current_price + (public.buyer_fee_ht(r.current_price) * 1.21), 2)
      )
      on conflict (lot_id) do nothing;
    end if;

    if v_new_status = 'sold' then
      perform public.notify_event(r.leading_bidder_id, 'auction_won', 'Tu as remporté ce lot !', r.title || ' — ' || r.current_price || ' €', 'compte.html#achats');
      perform public.notify_event(r.seller_id, 'lot_sold', 'Ton lot est vendu', r.title || ' — ' || r.current_price || ' €', 'compte.html#activite');
    else
      perform public.notify_event(r.seller_id, 'lot_unsold', 'Ton lot n''a pas trouvé preneur', r.title || ' — réserve non atteinte', 'compte.html#activite');
    end if;
  end loop;
end;
$$;

-- ============ VENTE : accord vendeur/acheteur, gating expertise, date butoir de paiement ============
create or replace function public.seller_respond_to_sale(p_sale_id uuid, p_accept boolean)
returns public.sales
language plpgsql
security definer
as $$
declare v_sale public.sales%rowtype; v_title text; v_needs_expertise boolean; v_has_report boolean;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if v_sale.id is null then
    raise exception 'Vente introuvable.';
  end if;
  if v_sale.seller_id <> auth.uid() then
    raise exception 'Tu n''es pas le vendeur de ce lot.';
  end if;

  v_needs_expertise := public.lot_requires_expertise(v_sale.lot_id);
  v_has_report := public.lot_has_approved_expertise(v_sale.lot_id);

  update public.sales
  set seller_accepted = p_accept,
      seller_decision_at = now(),
      status = case
        when p_accept = false then 'cancelled'
        when p_accept = true and v_sale.buyer_confirmed = true then
          case when v_needs_expertise and not v_has_report then 'awaiting_expertise' else 'confirmed' end
        else status
      end,
      confirmed_at = case
        when p_accept = true and v_sale.buyer_confirmed = true and not (v_needs_expertise and not v_has_report) then now()
        else confirmed_at
      end
  where id = p_sale_id
  returning * into v_sale;

  select title into v_title from public.lots where id = v_sale.lot_id;

  if p_accept then
    perform public.notify_event(v_sale.buyer_id, 'sale_accepted', 'Le vendeur a accepté la vente', v_title, 'compte.html#achats');
  end if;
  if v_sale.status = 'confirmed' then
    perform public.notify_event(v_sale.buyer_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#achats');
    perform public.notify_event(v_sale.seller_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#activite');
  elsif v_sale.status = 'awaiting_expertise' then
    perform public.notify_event(v_sale.seller_id, 'expertise_needed', 'Rapport d''expertise requis', v_title || ' — fournis (ou fais valider) le rapport pour débloquer la vente', 'compte.html#activite');
  end if;

  return v_sale;
end;
$$;

create or replace function public.buyer_confirm_sale(p_sale_id uuid, p_confirm boolean)
returns public.sales
language plpgsql
security definer
as $$
declare v_sale public.sales%rowtype; v_title text; v_needs_expertise boolean; v_has_report boolean;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if v_sale.id is null then
    raise exception 'Vente introuvable.';
  end if;
  if v_sale.buyer_id <> auth.uid() then
    raise exception 'Tu n''es pas l''acheteur de ce lot.';
  end if;

  v_needs_expertise := public.lot_requires_expertise(v_sale.lot_id);
  v_has_report := public.lot_has_approved_expertise(v_sale.lot_id);

  update public.sales
  set buyer_confirmed = p_confirm,
      buyer_decision_at = now(),
      status = case
        when p_confirm = false then 'cancelled'
        when p_confirm = true and v_sale.seller_accepted = true then
          case when v_needs_expertise and not v_has_report then 'awaiting_expertise' else 'confirmed' end
        else status
      end,
      confirmed_at = case
        when p_confirm = true and v_sale.seller_accepted = true and not (v_needs_expertise and not v_has_report) then now()
        else confirmed_at
      end
  where id = p_sale_id
  returning * into v_sale;

  select title into v_title from public.lots where id = v_sale.lot_id;

  if v_sale.status = 'confirmed' then
    perform public.notify_event(v_sale.buyer_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#achats');
    perform public.notify_event(v_sale.seller_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#activite');
  elsif v_sale.status = 'awaiting_expertise' then
    perform public.notify_event(v_sale.seller_id, 'expertise_needed', 'Rapport d''expertise requis', v_title || ' — fournis (ou fais valider) le rapport pour débloquer la vente', 'compte.html#activite');
  end if;

  return v_sale;
end;
$$;

-- ============ EXPERTISE : upload vendeur + validation/refus admin ============
create or replace function public.seller_upload_expertise(p_lot_id uuid, p_url text)
returns void
language plpgsql
security definer
as $$
declare v_admin record; v_title text;
begin
  if not exists (select 1 from public.lots where id = p_lot_id and seller_id = auth.uid()) then
    raise exception 'Tu n''es pas le vendeur de ce lot.';
  end if;

  update public.lots
  set expertise_report_url = p_url, expertise_status = 'pending', expertise_moderation_note = null,
      expertise_submitted_at = now()
  where id = p_lot_id;

  select title into v_title from public.lots where id = p_lot_id;
  for v_admin in select id from public.profiles where is_admin loop
    perform public.notify_event(v_admin.id, 'expertise_uploaded', 'Rapport d''expertise à valider', v_title, 'admin.html');
  end loop;
end;
$$;

create or replace function public.admin_approve_expertise(p_lot_id uuid)
returns void
language plpgsql
security definer
as $$
declare v_sale public.sales%rowtype; v_title text;
begin
  if not public.current_user_is_admin() then
    raise exception 'Réservé aux administrateurs.';
  end if;

  update public.lots set expertise_status = 'approved', expertise_moderation_note = null where id = p_lot_id;
  select title into v_title from public.lots where id = p_lot_id;

  select * into v_sale from public.sales where lot_id = p_lot_id and status = 'awaiting_expertise' for update;
  if v_sale.id is not null then
    update public.sales set status = 'confirmed', confirmed_at = now() where id = v_sale.id;
    perform public.notify_event(v_sale.buyer_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#achats');
    perform public.notify_event(v_sale.seller_id, 'sale_confirmed', 'Coordonnées disponibles', v_title, 'compte.html#activite');
  else
    perform public.notify_event(
      (select seller_id from public.lots where id = p_lot_id),
      'expertise_approved', 'Rapport d''expertise validé', v_title, 'lot.html?id=' || p_lot_id
    );
  end if;
end;
$$;

create or replace function public.admin_reject_expertise(p_lot_id uuid, p_note text)
returns void
language plpgsql
security definer
as $$
declare v_title text;
begin
  if not public.current_user_is_admin() then
    raise exception 'Réservé aux administrateurs.';
  end if;

  update public.lots set expertise_status = 'rejected', expertise_moderation_note = p_note where id = p_lot_id;
  select title into v_title from public.lots where id = p_lot_id;
  perform public.notify_event(
    (select seller_id from public.lots where id = p_lot_id),
    'expertise_rejected', 'Rapport d''expertise refusé', v_title || ' — ' || p_note, 'compte.html#activite'
  );
end;
$$;

grant execute on function public.seller_upload_expertise(uuid, text) to authenticated;
grant execute on function public.admin_approve_expertise(uuid) to authenticated;
grant execute on function public.admin_reject_expertise(uuid, text) to authenticated;
grant execute on function public.lot_has_approved_expertise(uuid) to authenticated;
grant execute on function public.lot_requires_expertise(uuid) to authenticated;

-- ============ MODÉRATION : notification vendeur sur approbation/refus d'un lot ============
create or replace function public.handle_lot_moderation_notify()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.status = 'live' and old.status in ('draft', 'scheduled') then
    perform public.notify_event(new.seller_id, 'lot_approved', 'Ton lot est en ligne', new.title, 'lot.html?id=' || new.id);
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.notify_event(new.seller_id, 'lot_rejected', 'Ton lot a été refusé', new.title || coalesce(' — ' || new.moderation_note, ''), 'compte.html#activite');
  end if;
  return new;
end;
$$;

drop trigger if exists on_lot_moderation_notify on public.lots;
create trigger on_lot_moderation_notify
  after update on public.lots
  for each row execute procedure public.handle_lot_moderation_notify();

-- ============ VUE lots_with_buyer_price : version finale (frais marginaux, colonnes à jour) ============
-- ATTENTION : "l.*" fige la liste des colonnes AU MOMENT de la création de la vue — à recréer
-- (drop + create, jamais un simple "create or replace") à chaque colonne ajoutée à "lots" après coup.
drop view if exists public.lots_with_buyer_price;
create view public.lots_with_buyer_price
with (security_invoker = on)
as
select
  l.*,
  round(public.buyer_fee_ht(l.current_price), 2) as buyer_fee_ht,
  round(public.buyer_fee_ht(l.current_price) * 0.21, 2) as buyer_fee_vat,
  round(l.current_price + (public.buyer_fee_ht(l.current_price) * 1.21), 2) as buyer_total_price
from public.lots l;

-- ============ RAPPELS AUTOMATIQUES : date butoir de paiement (7j après confirmation) ============
create or replace function public.check_payment_deadlines()
returns void
language plpgsql
security definer
as $$
declare r record; v_deadline timestamptz;
begin
  for r in select * from public.sales where status = 'confirmed' and confirmed_at is not null loop
    v_deadline := r.confirmed_at + interval '7 days';

    if v_deadline > now() and v_deadline <= now() + interval '2 days'
       and not exists (select 1 from public.notifications where user_id = r.buyer_id and type = 'payment_deadline_soon' and created_at > r.confirmed_at) then
      perform public.notify_event(r.buyer_id, 'payment_deadline_soon', 'Paiement à finaliser bientôt', 'Il te reste moins de 2 jours pour régler ton achat.', 'compte.html#achats');
    end if;

    if v_deadline <= now()
       and not exists (select 1 from public.notifications where user_id = r.buyer_id and type = 'payment_overdue' and created_at > r.confirmed_at) then
      perform public.notify_event(r.buyer_id, 'payment_overdue', 'Paiement en retard', 'La date limite de paiement de ton achat est dépassée.', 'compte.html#achats');
      perform public.notify_event(r.seller_id, 'payment_overdue', 'Paiement en retard côté acheteur', 'La date limite de paiement de ta vente est dépassée — contacte l''acheteur si besoin.', 'compte.html#activite');
    end if;
  end loop;
end;
$$;

select cron.schedule('check-payment-deadlines', '0 8 * * *', 'select public.check_payment_deadlines();');

-- ============ RGPD : purge des comptes inactifs depuis 2 ans (recommandation CNIL) ============
create or replace function public.warn_and_purge_inactive_accounts()
returns void
language plpgsql
security definer
as $$
declare v_user record;
begin
  for v_user in
    select p.id, p.full_name
    from public.profiles p
    join auth.users u on u.id = p.id
    where coalesce(u.last_sign_in_at, u.created_at) < now() - interval '23 months'
      and not exists (
        select 1 from public.notifications n
        where n.user_id = p.id and n.type = 'account_purge_warning'
          and n.created_at > now() - interval '2 months'
      )
  loop
    perform public.notify_event(
      v_user.id, 'account_purge_warning',
      'Ton compte Kriee sera bientôt supprimé pour inactivité',
      'Aucune connexion depuis presque 2 ans. Sans connexion dans les 30 prochains jours, ton compte et tes données personnelles seront supprimés, conformément à notre politique de confidentialité.',
      'connexion.html'
    );
  end loop;

  update public.profiles
  set full_name = null, phone = null, pseudo = 'compte-supprime-' || substr(id::text, 1, 8), city = null
  where id in (
    select p.id
    from public.profiles p
    join auth.users u on u.id = p.id
    where coalesce(u.last_sign_in_at, u.created_at) < now() - interval '24 months'
      and p.full_name is not null
  );
end;
$$;

select cron.schedule('warn-and-purge-inactive-accounts', '0 4 * * *', 'select public.warn_and_purge_inactive_accounts();');
