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
  for update using (auth.uid() = seller_id and status = 'draft');

-- ============ ENCHERES ============
create table public.bids (
  id uuid primary key default uuid_generate_v4(),
  lot_id uuid references public.lots(id) not null,
  bidder_id uuid references public.profiles(id) not null,
  amount numeric(10,2) not null,
  is_auto_bid boolean default false,
  max_auto_amount numeric(10,2),
  created_at timestamptz default now()
);

create index on public.bids (lot_id, amount desc);

alter table public.bids enable row level security;
create policy "encheres visibles par tous" on public.bids for select using (true);
create policy "un user enchérit en son nom" on public.bids
  for insert with check (auth.uid() = bidder_id);

-- ============ FONCTION : poser une enchère (avec verrou + anti-sniping + anti-surenchère sur soi-même + limite bateaux) ============
-- Règles :
--  - le montant doit être >= prix courant + palier
--  - si l'enchère arrive dans les 3 dernières minutes, la clôture est repoussée de 3 min (anti-sniping)
--  - un enchérisseur déjà en tête ne peut pas remonter sa propre enchère tant que personne ne l'a dépassé
--  - sur un BATEAU (voile/moteur/semi-rigide) : impossible d'être en tête sur plus d'un bateau à la fois.
--    L'équipement/accastillage reste libre — un panier de plusieurs petits achats simultanés est raisonnable.
create or replace function public.place_bid(p_lot_id uuid, p_amount numeric)
returns public.lots
language plpgsql
security definer
as $$
declare
  v_lot public.lots%rowtype;
  v_last_bidder uuid;
  v_category_slug text;
begin
  select * into v_lot from public.lots where id = p_lot_id for update;

  if v_lot.status <> 'live' then
    raise exception 'Ce lot n''est pas ouvert aux enchères.';
  end if;

  if now() > v_lot.ends_at then
    raise exception 'Cette enchère est terminée.';
  end if;

  if p_amount < v_lot.current_price + v_lot.bid_increment then
    raise exception 'Montant insuffisant. Minimum : % €', v_lot.current_price + v_lot.bid_increment;
  end if;

  select bidder_id into v_last_bidder
  from public.bids
  where lot_id = p_lot_id
  order by amount desc, created_at desc
  limit 1;

  if v_last_bidder = auth.uid() then
    raise exception 'Tu es déjà le meilleur enchérisseur sur ce lot. Attends qu''un autre acheteur enchérisse avant de remonter.';
  end if;

  select slug into v_category_slug from public.categories where id = v_lot.category_id;

  if v_category_slug <> 'equipement' and exists (
    select 1
    from public.lots l2
    join public.categories c2 on c2.id = l2.category_id
    where l2.status = 'live'
      and l2.id <> p_lot_id
      and c2.slug <> 'equipement'
      and (
        select b2.bidder_id from public.bids b2
        where b2.lot_id = l2.id
        order by b2.amount desc, b2.created_at desc
        limit 1
      ) = auth.uid()
  ) then
    raise exception 'Tu es déjà en tête sur un autre bateau. Une seule enchère "bateau" active à la fois — termine ou fais-toi dépasser sur celle-ci avant d''en démarrer une autre.';
  end if;

  insert into public.bids (lot_id, bidder_id, amount)
  values (p_lot_id, auth.uid(), p_amount);

  update public.lots
  set current_price = p_amount,
      ends_at = case
        when ends_at - now() < interval '3 minutes'
        then now() + interval '3 minutes'
        else ends_at
      end
  where id = p_lot_id
  returning * into v_lot;

  return v_lot;
end;
$$;

-- ============ VUE : calcul du prix acheteur (frais 18% + TVA 21% sur les frais) ============
create or replace view public.lots_with_buyer_price as
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
