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
  status text not null default 'draft' check (status in ('draft','scheduled','live','sold','unsold','cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  cover_image_url text,
  images text[] default '{}',
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

-- ============ FONCTION : poser une enchère (avec verrou + anti-sniping) ============
-- Règles :
--  - le montant doit être >= prix courant + palier
--  - si l'enchère arrive dans les 3 dernières minutes, la clôture est repoussée de 3 min (anti-sniping)
create or replace function public.place_bid(p_lot_id uuid, p_amount numeric)
returns public.lots
language plpgsql
security definer
as $$
declare
  v_lot public.lots%rowtype;
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

-- ============ REALTIME ============
alter publication supabase_realtime add table public.bids;
alter publication supabase_realtime add table public.lots;
