alter table public.orders
  add column canteen_id uuid references public.canteens (id);

alter table public.products
  add column category text not null default 'Other'
  check (category in ('Food', 'Drinks', 'Other'));

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete cascade,
  assigned_rider_id uuid references public.rider_profiles (id),
  pickup_location text not null,
  destination text not null,
  status text not null default 'available' check (status in ('available', 'accepted', 'picked_up', 'delivered', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'available' and assigned_rider_id is null) or (status <> 'available' and (status = 'cancelled' or assigned_rider_id is not null)))
);

create table public.earnings_ledger (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.rider_profiles (id),
  delivery_id uuid not null unique references public.deliveries (id),
  amount numeric(10, 2) check (amount is null or amount >= 0),
  transaction_status text not null check (transaction_status in ('pending_configuration', 'recorded', 'paid')),
  created_at timestamptz not null default now(),
  check ((transaction_status = 'pending_configuration' and amount is null) or (transaction_status in ('recorded', 'paid') and amount is not null))
);

create table public.delivery_settings (
  singleton boolean primary key default true check (singleton),
  rider_compensation_per_delivery numeric(10, 2) check (rider_compensation_per_delivery is null or rider_compensation_per_delivery >= 0),
  updated_at timestamptz not null default now()
);

insert into public.delivery_settings (singleton, rider_compensation_per_delivery)
values (true, null);

create index deliveries_available_created_at_idx on public.deliveries (created_at) where status = 'available';
create index deliveries_rider_created_at_idx on public.deliveries (assigned_rider_id, created_at desc);
create index earnings_rider_created_at_idx on public.earnings_ledger (rider_id, created_at desc);

alter table public.deliveries enable row level security;
alter table public.earnings_ledger enable row level security;
alter table public.delivery_settings enable row level security;

revoke all on public.profiles, public.canteens, public.products, public.rider_profiles,
  public.orders, public.order_items, public.deliveries, public.earnings_ledger,
  public.delivery_settings from anon, authenticated;
grant select on public.profiles, public.canteens, public.products, public.rider_profiles,
  public.orders, public.order_items to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select on public.deliveries, public.earnings_ledger to authenticated;

create policy "Verified students can read eligible or assigned deliveries"
on public.deliveries for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and (
    assigned_rider_id = (select auth.uid())
    or (
      status = 'available'
      and exists (
        select 1 from public.rider_profiles as rider
        where rider.id = (select auth.uid()) and rider.is_available
      )
      and exists (
        select 1 from public.orders as customer_order
        where customer_order.id = deliveries.order_id
          and customer_order.customer_id <> (select auth.uid())
      )
    )
  )
);

create policy "Verified students can read their earnings ledger"
on public.earnings_ledger for select to authenticated
using (rider_id = (select auth.uid()) and (select public.is_verified_nitsri_user()));

create or replace function public.provision_rider_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.rider_profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.provision_rider_profile() from public, anon, authenticated;
create trigger provision_rider_after_profile_insert
after insert on public.profiles
for each row execute function public.provision_rider_profile();

insert into public.rider_profiles (id)
select profile.id from public.profiles as profile
on conflict (id) do nothing;

create or replace function public.set_rider_availability(available boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  insert into public.rider_profiles (id, is_available, is_active)
  values (user_id, available, true)
  on conflict (id) do update
  set is_available = excluded.is_available,
      is_active = true,
      updated_at = now();

  return available;
end;
$$;

create or replace function public.place_order(items jsonb, delivery_destination text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  product_count integer;
  requested_count integer;
  matched_canteen uuid;
  matched_pickup text;
  new_order_id uuid;
  computed_total numeric(10, 2);
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if delivery_destination is null or length(btrim(delivery_destination)) < 2 or length(delivery_destination) > 240 then
    raise exception using errcode = '22023', message = 'Enter a valid delivery destination.';
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 30 then
    raise exception using errcode = '22023', message = 'An order must contain between 1 and 30 products.';
  end if;

  with requested as (
        select (line.value ->> 'product_id')::uuid as product_id,
          (line.value ->> 'quantity')::integer as quantity
        from jsonb_array_elements(items) as line(value)
  )
  select count(*), count(distinct requested.product_id)
  into requested_count, product_count
  from requested
  where requested.product_id is not null and requested.quantity between 1 and 50;

  if requested_count <> jsonb_array_length(items) or product_count <> requested_count then
    raise exception using errcode = '22023', message = 'The order contains invalid or duplicate product entries.';
  end if;

  with requested as (
        select (line.value ->> 'product_id')::uuid as product_id,
          (line.value ->> 'quantity')::integer as quantity
        from jsonb_array_elements(items) as line(value)
  ), selected as (
    select product.id, product.canteen_id, product.price, product.name,
           requested.quantity, canteen.location
    from requested
    join public.products as product on product.id = requested.product_id
    join public.canteens as canteen on canteen.id = product.canteen_id
    where product.is_available and canteen.is_active
  )
  select count(*), count(distinct selected.canteen_id), (array_agg(selected.canteen_id))[1], (array_agg(selected.location))[1],
         sum(selected.price * selected.quantity)
  into requested_count, product_count, matched_canteen, matched_pickup, computed_total
  from selected;

  if requested_count <> jsonb_array_length(items) then
    raise exception using errcode = '22023', message = 'One or more selected products are no longer available.';
  end if;
  if product_count <> 1 then
    raise exception using errcode = '22023', message = 'Please place a separate order for each canteen.';
  end if;

  insert into public.orders (customer_id, canteen_id, delivery_location, total_amount, status)
  values (user_id, matched_canteen, btrim(delivery_destination), computed_total, 'placed')
  returning id into new_order_id;

  insert into public.order_items (order_id, product_id, product_name, unit_price, quantity)
  select new_order_id, product.id, product.name, product.price, requested.quantity
  from jsonb_to_recordset(items) as requested(product_id uuid, quantity integer)
  join public.products as product on product.id = requested.product_id;

  insert into public.deliveries (order_id, pickup_location, destination)
  values (new_order_id, coalesce(nullif(btrim(matched_pickup), ''), 'Canteen location to be confirmed'), btrim(delivery_destination));

  return new_order_id;
end;
$$;

create or replace function public.get_delivery_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  result jsonb;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  select jsonb_build_object(
    'is_online', coalesce(rider.is_available, false),
    'compensation_configured', settings.rider_compensation_per_delivery is not null,
    'available', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', delivery.id,
        'order_id', delivery.order_id,
        'pickup_location', delivery.pickup_location,
        'destination', delivery.destination,
        'created_at', delivery.created_at,
        'items', (
          select jsonb_agg(jsonb_build_object('name', line.product_name, 'quantity', line.quantity))
          from public.order_items as line where line.order_id = delivery.order_id
        )
      ) order by delivery.created_at)
      from public.deliveries as delivery
      join public.orders as customer_order on customer_order.id = delivery.order_id
      where delivery.status = 'available'
        and customer_order.customer_id <> user_id
        and rider.is_available
    ), '[]'::jsonb),
    'active', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', delivery.id,
        'order_id', delivery.order_id,
        'pickup_location', delivery.pickup_location,
        'destination', delivery.destination,
        'status', delivery.status,
        'created_at', delivery.created_at,
        'items', (
          select jsonb_agg(jsonb_build_object('name', line.product_name, 'quantity', line.quantity))
          from public.order_items as line where line.order_id = delivery.order_id
        )
      ) order by delivery.created_at desc)
      from public.deliveries as delivery
      where delivery.assigned_rider_id = user_id and delivery.status in ('accepted', 'picked_up')
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', delivery.id,
        'order_id', delivery.order_id,
        'destination', delivery.destination,
        'completed_at', delivery.completed_at
      ) order by delivery.completed_at desc)
      from public.deliveries as delivery
      where delivery.assigned_rider_id = user_id and delivery.status = 'delivered'
    ), '[]'::jsonb),
    'earnings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ledger.id,
        'delivery_id', ledger.delivery_id,
        'amount', ledger.amount,
        'status', ledger.transaction_status,
        'created_at', ledger.created_at
      ) order by ledger.created_at desc)
      from public.earnings_ledger as ledger
      where ledger.rider_id = user_id
    ), '[]'::jsonb),
    'total_earnings', coalesce((
      select sum(ledger.amount)
      from public.earnings_ledger as ledger
      where ledger.rider_id = user_id and ledger.transaction_status in ('recorded', 'paid')
    ), 0)
  ) into result
  from (select 1) as seed
  left join public.rider_profiles as rider on rider.id = user_id
  cross join public.delivery_settings as settings
  where settings.singleton;

  return coalesce(result, '{}'::jsonb);
end;
$$;

create or replace function public.accept_delivery(delivery_uuid uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  accepted_order uuid;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if not exists (select 1 from public.rider_profiles where id = user_id and is_available) then
    raise exception using errcode = '42501', message = 'Go online before accepting a delivery.';
  end if;

  update public.deliveries as delivery
  set assigned_rider_id = user_id,
      status = 'accepted',
      updated_at = now()
  where delivery.id = delivery_uuid
    and delivery.status = 'available'
    and delivery.assigned_rider_id is null
    and exists (
      select 1 from public.orders as customer_order
      where customer_order.id = delivery.order_id and customer_order.customer_id <> user_id
    )
  returning delivery.order_id into accepted_order;

  if accepted_order is null then
    raise exception using errcode = '40001', message = 'This delivery is no longer available.';
  end if;

  update public.orders set delivery_partner_id = user_id, status = 'accepted', updated_at = now()
  where id = accepted_order;
  return accepted_order;
end;
$$;

create or replace function public.update_delivery_status(delivery_uuid uuid, next_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  current_status text;
  related_order uuid;
  configured_compensation numeric(10, 2);
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if next_status not in ('picked_up', 'delivered') then
    raise exception using errcode = '22023', message = 'That delivery status transition is not supported.';
  end if;

  select delivery.status, delivery.order_id into current_status, related_order
  from public.deliveries as delivery
  where delivery.id = delivery_uuid and delivery.assigned_rider_id = user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This delivery is not assigned to your account.';
  end if;
  if (current_status = 'accepted' and next_status <> 'picked_up') or (current_status = 'picked_up' and next_status <> 'delivered') then
    raise exception using errcode = '22023', message = 'The delivery status transition is invalid.';
  end if;

  update public.deliveries
  set status = next_status,
      updated_at = now(),
      completed_at = case when next_status = 'delivered' then now() else completed_at end
  where id = delivery_uuid;

  update public.orders set status = next_status, updated_at = now() where id = related_order;

  if next_status = 'delivered' then
    select rider_compensation_per_delivery into configured_compensation
    from public.delivery_settings where singleton;

    insert into public.earnings_ledger (rider_id, delivery_id, amount, transaction_status)
    values (
      user_id,
      delivery_uuid,
      configured_compensation,
      case when configured_compensation is null then 'pending_configuration' else 'recorded' end
    )
    on conflict (delivery_id) do nothing;
  end if;

  return next_status;
end;
$$;

revoke all on function public.set_rider_availability(boolean) from public, anon;
revoke all on function public.place_order(jsonb, text) from public, anon;
revoke all on function public.get_delivery_workspace() from public, anon;
revoke all on function public.accept_delivery(uuid) from public, anon;
revoke all on function public.update_delivery_status(uuid, text) from public, anon;
grant execute on function public.set_rider_availability(boolean) to authenticated;
grant execute on function public.place_order(jsonb, text) to authenticated;
grant execute on function public.get_delivery_workspace() to authenticated;
grant execute on function public.accept_delivery(uuid) to authenticated;
grant execute on function public.update_delivery_status(uuid, text) to authenticated;
