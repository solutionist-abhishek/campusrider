create or replace function public.enforce_nitsri_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or lower(btrim(new.email)) !~ '^[^[:space:]@]+@nitsri[.]ac[.]in$' then
    raise exception using
      errcode = 'check_violation',
      message = 'Please use your official NIT Srinagar email address ending in @nitsri.ac.in.';
  end if;

  new.email := lower(btrim(new.email));
  return new;
end;
$$;

revoke all on function public.enforce_nitsri_email() from public, anon, authenticated;

create trigger enforce_nitsri_email_before_auth_user_write
before insert or update of email on auth.users
for each row execute function public.enforce_nitsri_email();

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(btrim(new.email)),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(lower(btrim(new.email)), '@', 1))
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
      updated_at = now();

  return new;
end;
$$;

revoke all on function public.sync_auth_profile() from public, anon, authenticated;

create trigger sync_profile_after_auth_user_write
 after insert or update of email, raw_user_meta_data on auth.users
 for each row execute function public.sync_auth_profile();

create or replace function public.is_verified_nitsri_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = (select auth.uid())
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$'
  );
$$;

revoke all on function public.is_verified_nitsri_user() from public, anon;
grant execute on function public.is_verified_nitsri_user() to authenticated;

create table public.canteens (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  description text not null default '',
  location text not null default '',
  operating_hours jsonb not null default '{}'::jsonb,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  canteen_id uuid not null references public.canteens (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  image_url text,
  is_available boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rider_profiles (
  id uuid primary key references public.profiles (id) on delete cascade,
  is_active boolean not null default false,
  is_available boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id),
  delivery_partner_id uuid references public.rider_profiles (id),
  status text not null default 'placed' check (status in ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'delivered', 'cancelled')),
  delivery_location text not null,
  total_amount numeric(10, 2) not null default 0 check (total_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index products_canteen_id_idx on public.products (canteen_id);
create index orders_customer_created_at_idx on public.orders (customer_id, created_at desc);
create index orders_delivery_partner_id_idx on public.orders (delivery_partner_id);
create index order_items_order_id_idx on public.order_items (order_id);

alter table public.profiles enable row level security;
alter table public.canteens enable row level security;
alter table public.products enable row level security;
alter table public.rider_profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select on public.canteens, public.products, public.rider_profiles to authenticated;
grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;

create policy "Verified students can read their profile"
on public.profiles for select to authenticated
using (id = (select auth.uid()) and (select public.is_verified_nitsri_user()));

create policy "Verified students can update their profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()) and (select public.is_verified_nitsri_user()))
with check (id = (select auth.uid()) and (select public.is_verified_nitsri_user()));

create policy "Verified students can browse active canteens"
on public.canteens for select to authenticated
using (is_active and (select public.is_verified_nitsri_user()));

create policy "Verified students can browse available products"
on public.products for select to authenticated
using (
  is_available
  and (select public.is_verified_nitsri_user())
  and exists (
    select 1 from public.canteens as canteen
    where canteen.id = products.canteen_id and canteen.is_active
  )
);

create policy "Verified students can read their rider profile"
on public.rider_profiles for select to authenticated
using (id = (select auth.uid()) and (select public.is_verified_nitsri_user()));

create policy "Verified students can read their orders"
on public.orders for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and (
    customer_id = (select auth.uid())
    or delivery_partner_id = (select auth.uid())
  )
);

create policy "Verified students can read items on their orders"
on public.order_items for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and exists (
    select 1 from public.orders as customer_order
    where customer_order.id = order_items.order_id
      and (customer_order.customer_id = (select auth.uid()) or customer_order.delivery_partner_id = (select auth.uid()))
  )
);
