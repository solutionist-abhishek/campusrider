create table public.pickup_locations (
  id text primary key check (id in ('canteen', 'cafeteria', 'gate')),
  name text not null unique,
  delivery_fee numeric(10, 2) check (delivery_fee is null or delivery_fee >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.pickup_locations (id, name)
values
  ('canteen', 'Canteen'),
  ('cafeteria', 'Cafeteria'),
  ('gate', 'Gate')
on conflict (id) do update set name = excluded.name, is_active = true;

alter table public.profiles add column avatar_url text;
alter table public.rider_profiles
  add column supported_pickup_locations text[] not null default '{}',
  add column delivery_capacity integer not null default 3
    check (delivery_capacity between 1 and 20),
  add constraint rider_profiles_supported_pickup_locations_check
    check (supported_pickup_locations <@ array['canteen', 'cafeteria', 'gate']::text[]);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  rider_id uuid not null references public.rider_profiles (id) on delete cascade,
  pickup_location_id text not null references public.pickup_locations (id),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_id <> rider_id)
);

create unique index conversations_one_open_pair_idx
  on public.conversations (customer_id, rider_id, pickup_location_id)
  where status = 'open';
create index conversations_customer_updated_idx
  on public.conversations (customer_id, updated_at desc);
create index conversations_rider_updated_idx
  on public.conversations (rider_id, updated_at desc);

create table public.delivery_requests (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  customer_id uuid not null references public.profiles (id),
  rider_id uuid not null references public.rider_profiles (id),
  pickup_location_id text not null references public.pickup_locations (id),
  instructions text not null check (length(btrim(instructions)) between 1 and 20000),
  destination text check (destination is null or length(btrim(destination)) between 2 and 240),
  status text not null default 'pending'
    check (status in ('pending', 'quoted', 'rejected', 'accepted', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index delivery_requests_customer_updated_idx
  on public.delivery_requests (customer_id, updated_at desc);
create index delivery_requests_rider_updated_idx
  on public.delivery_requests (rider_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.delivery_requests (conversation_id) on delete cascade,
  rider_id uuid not null references public.rider_profiles (id),
  item_subtotal numeric(10, 2) not null check (item_subtotal >= 0),
  delivery_fee numeric(10, 2) not null check (delivery_fee >= 0),
  total_amount numeric(10, 2) not null check (total_amount = item_subtotal + delivery_fee),
  delivery_destination text check (delivery_destination is null or length(btrim(delivery_destination)) between 2 and 240),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 1 and 240),
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'rejected', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quotes_request_created_idx on public.quotes (request_id, created_at desc);
create unique index quotes_one_proposed_per_request_idx
  on public.quotes (request_id) where status = 'proposed';

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  item_name text not null check (length(btrim(item_name)) between 1 and 120),
  quantity integer not null check (quantity between 1 and 99),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  line_total numeric(10, 2) not null check (line_total = unit_price * quantity),
  created_at timestamptz not null default now()
);
create index quote_items_quote_idx on public.quote_items (quote_id);

alter table public.orders
  add column pickup_location_id text references public.pickup_locations (id),
  add column delivery_fee numeric(10, 2) check (delivery_fee is null or delivery_fee >= 0),
  add column accepted_quote_id uuid unique references public.quotes (id);

alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'collecting', 'collected', 'on_the_way', 'delivered', 'cancelled'));

alter table public.deliveries drop constraint deliveries_status_check;
alter table public.deliveries add constraint deliveries_status_check
  check (status in ('available', 'accepted', 'picked_up', 'collecting', 'collected', 'on_the_way', 'delivered', 'cancelled'));

alter table public.pickup_locations enable row level security;
alter table public.conversations enable row level security;
alter table public.delivery_requests enable row level security;
alter table public.messages enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;

revoke all on public.pickup_locations, public.conversations, public.delivery_requests,
  public.messages, public.quotes, public.quote_items from anon, authenticated;
grant select on public.pickup_locations, public.conversations, public.delivery_requests,
  public.messages, public.quotes, public.quote_items to authenticated;

create policy "Verified students can read active pickup locations"
on public.pickup_locations for select to authenticated
using (is_active and (select public.is_verified_nitsri_user()));

create policy "Conversation participants can read conversations"
on public.conversations for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and (customer_id = (select auth.uid()) or rider_id = (select auth.uid()))
);

create policy "Request participants can read requests"
on public.delivery_requests for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and (customer_id = (select auth.uid()) or rider_id = (select auth.uid()))
);

create policy "Conversation participants can read messages"
on public.messages for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and exists (
    select 1 from public.conversations as conversation
    where conversation.id = messages.conversation_id
      and (conversation.customer_id = (select auth.uid()) or conversation.rider_id = (select auth.uid()))
  )
);

create policy "Request participants can read quotes"
on public.quotes for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and exists (
    select 1 from public.delivery_requests as request
    where request.conversation_id = quotes.request_id
      and (request.customer_id = (select auth.uid()) or request.rider_id = (select auth.uid()))
  )
);

create policy "Request participants can read quote items"
on public.quote_items for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and exists (
    select 1
    from public.quotes as quote
    join public.delivery_requests as request on request.conversation_id = quote.request_id
    where quote.id = quote_items.quote_id
      and (request.customer_id = (select auth.uid()) or request.rider_id = (select auth.uid()))
  )
);

create or replace function public.set_rider_pickup_availability(
  pickup_locations text[],
  online boolean
)
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
  if pickup_locations is null
    or online is null
    or cardinality(pickup_locations) > 3
    or exists (
      select 1
      from unnest(pickup_locations) as selected(location_id)
      where selected.location_id is null
        or selected.location_id not in ('canteen', 'cafeteria', 'gate')
    )
    or cardinality(pickup_locations) <> (
      select count(distinct selected.location_id)
      from unnest(pickup_locations) as selected(location_id)
    )
  then
    raise exception using errcode = '22023', message = 'Choose valid, non-duplicate pickup locations.';
  end if;
  if online and cardinality(pickup_locations) = 0 then
    raise exception using errcode = '22023', message = 'Select at least one pickup location before going online.';
  end if;

  insert into public.rider_profiles (id, is_active, is_available, supported_pickup_locations)
  values (user_id, true, online, pickup_locations)
  on conflict (id) do update
  set is_active = true,
      is_available = excluded.is_available,
      supported_pickup_locations = excluded.supported_pickup_locations,
      updated_at = now();

  return online;
end;
$$;

create or replace function public.list_available_pickup_riders(location_id text)
returns table (
  rider_id uuid,
  full_name text,
  avatar_url text,
  workload integer,
  capacity integer,
  delivery_fee numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if location_id is null or location_id not in ('canteen', 'cafeteria', 'gate') then
    raise exception using errcode = '22023', message = 'Choose a supported pickup location.';
  end if;

  return query
  select rider.id,
         profile.full_name,
         profile.avatar_url,
         count(delivery.id)::integer,
         rider.delivery_capacity,
         pickup.delivery_fee
  from public.rider_profiles as rider
  join public.profiles as profile on profile.id = rider.id
  join public.pickup_locations as pickup on pickup.id = location_id and pickup.is_active
  left join public.deliveries as delivery
    on delivery.assigned_rider_id = rider.id
    and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
  where rider.is_active
    and rider.is_available
    and location_id = any(rider.supported_pickup_locations)
    and exists (
      select 1 from auth.users as auth_user
      where auth_user.id = rider.id
        and auth_user.email_confirmed_at is not null
        and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$'
    )
  group by rider.id, profile.full_name, profile.avatar_url, rider.delivery_capacity, pickup.delivery_fee
  having count(delivery.id) < rider.delivery_capacity
  order by count(delivery.id), profile.full_name;
end;
$$;

create or replace function public.get_my_rider_pickup_settings()
returns table (
  is_online boolean,
  supported_locations text[],
  capacity integer,
  workload integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  return query
  select coalesce(rider.is_available, false),
         coalesce(rider.supported_pickup_locations, '{}'::text[]),
         coalesce(rider.delivery_capacity, 3),
         (
           select count(*)::integer
           from public.deliveries as delivery
           where delivery.assigned_rider_id = user_id
             and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
         )
  from (select 1) as seed
  left join public.rider_profiles as rider on rider.id = user_id;
end;
$$;

create or replace function public.open_pickup_conversation(location_id text, selected_rider_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  conversation_uuid uuid;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if location_id is null
    or location_id not in ('canteen', 'cafeteria', 'gate')
    or selected_rider_id is null
    or selected_rider_id = user_id
  then
    raise exception using errcode = '22023', message = 'Choose a valid rider and pickup location.';
  end if;
  if not exists (
    select 1
    from public.rider_profiles as rider
    join public.pickup_locations as pickup on pickup.id = location_id and pickup.is_active
    join auth.users as auth_user on auth_user.id = rider.id
    where rider.id = selected_rider_id
      and rider.is_active
      and rider.is_available
      and location_id = any(rider.supported_pickup_locations)
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$'
      and (
        select count(*)
        from public.deliveries as delivery
        where delivery.assigned_rider_id = rider.id
          and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
      ) < rider.delivery_capacity
  ) then
    raise exception using errcode = '42501', message = 'This rider is no longer available for that pickup location.';
  end if;

  insert into public.conversations (customer_id, rider_id, pickup_location_id)
  values (user_id, selected_rider_id, location_id)
  on conflict (customer_id, rider_id, pickup_location_id) where status = 'open'
  do update set updated_at = now()
  returning id into conversation_uuid;
  return conversation_uuid;
end;
$$;

create or replace function public.get_my_pickup_conversations()
returns table (
  conversation_id uuid,
  pickup_location_id text,
  pickup_name text,
  other_person_name text,
  request_status text,
  destination text,
  last_message text,
  updated_at timestamptz,
  is_customer boolean,
  conversation_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  return query
  select conversation.id,
         conversation.pickup_location_id,
         pickup.name,
         other_profile.full_name,
         request.status,
         request.destination,
         recent.body,
         conversation.updated_at,
         conversation.customer_id = user_id,
         conversation.status
  from public.conversations as conversation
  join public.pickup_locations as pickup on pickup.id = conversation.pickup_location_id
  join public.profiles as other_profile
    on other_profile.id = case when conversation.customer_id = user_id then conversation.rider_id else conversation.customer_id end
  left join public.delivery_requests as request on request.conversation_id = conversation.id
  left join lateral (
    select message.body
    from public.messages as message
    where message.conversation_id = conversation.id
    order by message.created_at desc
    limit 1
  ) as recent on true
  where conversation.customer_id = user_id or conversation.rider_id = user_id
  order by conversation.updated_at desc;
end;
$$;

create or replace function public.send_pickup_message(conversation_uuid uuid, message_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  new_message_id uuid;
  selected_conversation public.conversations%rowtype;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if message_body is null or length(btrim(message_body)) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Messages must contain between 1 and 2000 characters.';
  end if;

  select * into selected_conversation
  from public.conversations as conversation
  where conversation.id = conversation_uuid
    and (conversation.customer_id = user_id or conversation.rider_id = user_id)
    and conversation.status = 'open';
  if not found then
    raise exception using errcode = '42501', message = 'This conversation is unavailable or closed.';
  end if;

  if user_id = selected_conversation.customer_id then
    insert into public.delivery_requests (conversation_id, customer_id, rider_id, pickup_location_id, instructions)
    values (
      selected_conversation.id,
      selected_conversation.customer_id,
      selected_conversation.rider_id,
      selected_conversation.pickup_location_id,
      btrim(message_body)
    )
    on conflict (conversation_id) do update
    set instructions = left(delivery_requests.instructions || E'\n' || btrim(message_body), 20000),
        status = case when delivery_requests.status in ('quoted', 'rejected') then 'pending' else delivery_requests.status end,
        updated_at = now();

    update public.quotes
    set status = 'superseded', updated_at = now()
    where request_id = selected_conversation.id and status = 'proposed';
  end if;

  insert into public.messages (conversation_id, sender_id, body)
  values (selected_conversation.id, user_id, btrim(message_body))
  returning id into new_message_id;

  update public.conversations set updated_at = now() where id = selected_conversation.id;
  return new_message_id;
end;
$$;

create or replace function public.create_pickup_quote(
  conversation_uuid uuid,
  items jsonb,
  delivery_destination text,
  estimated_minutes integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  request_row public.delivery_requests%rowtype;
  configured_fee numeric(10, 2);
  computed_subtotal numeric;
  new_quote_id uuid;
  item_count integer;
  rider_capacity integer;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' then
    raise exception using errcode = '22023', message = 'A quote must contain between 1 and 30 items.';
  end if;
  if jsonb_array_length(items) not between 1 and 30 then
    raise exception using errcode = '22023', message = 'A quote must contain between 1 and 30 items.';
  end if;
  if delivery_destination is not null and length(btrim(delivery_destination)) not between 2 and 240 then
    raise exception using errcode = '22023', message = 'Enter a valid delivery destination or leave it blank.';
  end if;
  if estimated_minutes is not null and estimated_minutes not between 1 and 240 then
    raise exception using errcode = '22023', message = 'Estimated delivery time must be between 1 and 240 minutes.';
  end if;

  select * into request_row
  from public.delivery_requests as request
  where request.conversation_id = conversation_uuid
    and request.rider_id = user_id
    and request.status in ('pending', 'rejected')
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'There is no active request for you to quote.';
  end if;

  select rider.delivery_capacity into rider_capacity
  from public.rider_profiles as rider
  where rider.id = user_id
    and rider.is_active
    and rider.is_available
    and request_row.pickup_location_id = any(rider.supported_pickup_locations)
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Go online for this pickup location before sending a quote.';
  end if;
  if (
    select count(*)
    from public.deliveries as delivery
    where delivery.assigned_rider_id = user_id
      and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
  ) >= rider_capacity then
    raise exception using errcode = '42501', message = 'Your active delivery capacity is full.';
  end if;

  select pickup.delivery_fee into configured_fee
  from public.pickup_locations as pickup
  where pickup.id = request_row.pickup_location_id and pickup.is_active;
  if configured_fee is null then
    raise exception using errcode = '22023', message = 'The fixed delivery charge has not been configured for this pickup location.';
  end if;

  select count(*), sum(line.unit_price * line.quantity)
  into item_count, computed_subtotal
  from jsonb_to_recordset(items) as line(name text, quantity integer, unit_price numeric);
  if item_count <> jsonb_array_length(items)
    or exists (
      select 1
      from jsonb_to_recordset(items) as line(name text, quantity integer, unit_price numeric)
      where line.name is null
        or length(btrim(line.name)) not between 1 and 120
        or line.quantity is null
        or line.quantity not between 1 and 99
        or line.unit_price is null
        or line.unit_price < 0
        or line.unit_price > 99999999.99
        or (line.unit_price <> round(line.unit_price, 2))
    )
  then
    raise exception using errcode = '22023', message = 'Quote items need a name, quantity from 1 to 99, and a price with at most two decimal places.';
  end if;
  if computed_subtotal > 99999999.99 - configured_fee then
    raise exception using errcode = '22023', message = 'The quote amount is outside the supported range.';
  end if;

  update public.quotes set status = 'superseded', updated_at = now()
  where request_id = request_row.conversation_id and status = 'proposed';

  insert into public.quotes (
    request_id, rider_id, item_subtotal, delivery_fee, total_amount,
    delivery_destination, estimated_minutes, status
  )
  values (
    request_row.conversation_id,
    user_id,
    computed_subtotal,
    configured_fee,
    computed_subtotal + configured_fee,
    coalesce(nullif(btrim(delivery_destination), ''), request_row.destination),
    estimated_minutes,
    'proposed'
  )
  returning id into new_quote_id;

  insert into public.quote_items (quote_id, item_name, quantity, unit_price, line_total)
  select new_quote_id, btrim(line.name), line.quantity, line.unit_price, line.unit_price * line.quantity
  from jsonb_to_recordset(items) as line(name text, quantity integer, unit_price numeric);

  update public.delivery_requests
  set status = 'quoted',
      destination = coalesce(nullif(btrim(delivery_destination), ''), destination),
      updated_at = now()
  where conversation_id = request_row.conversation_id;
  update public.conversations set updated_at = now() where id = request_row.conversation_id;
  return new_quote_id;
end;
$$;

create or replace function public.respond_to_pickup_quote(quote_uuid uuid, accept_quote boolean, destination text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  selected_quote public.quotes%rowtype;
  request_row public.delivery_requests%rowtype;
  selected_request_id uuid;
  order_uuid uuid;
  chosen_destination text;
  rider_capacity integer;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if accept_quote is null then
    raise exception using errcode = '22023', message = 'Choose whether to accept or reject the quote.';
  end if;

  select quote.request_id into selected_request_id
  from public.quotes as quote
  where quote.id = quote_uuid;
  if not found then
    raise exception using errcode = '40001', message = 'This quote is no longer awaiting a response.';
  end if;

  select * into request_row
  from public.delivery_requests as request
  where request.conversation_id = selected_request_id
  for update;
  if not found or request_row.customer_id <> user_id then
    raise exception using errcode = '42501', message = 'Only the requesting customer can respond to this quote.';
  end if;

  select * into selected_quote
  from public.quotes as quote
  where quote.id = quote_uuid
    and quote.request_id = selected_request_id
  for update;
  if not found or selected_quote.status <> 'proposed' then
    raise exception using errcode = '40001', message = 'This quote is no longer awaiting a response.';
  end if;

  if not accept_quote then
    update public.quotes set status = 'rejected', updated_at = now() where id = quote_uuid;
    update public.delivery_requests set status = 'rejected', updated_at = now()
    where conversation_id = selected_quote.request_id;
    update public.conversations set updated_at = now() where id = selected_quote.request_id;
    return null;
  end if;

  select rider.delivery_capacity into rider_capacity
  from public.rider_profiles as rider
  where rider.id = request_row.rider_id
    and rider.is_active
    and rider.is_available
    and request_row.pickup_location_id = any(rider.supported_pickup_locations)
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'The rider is no longer available for this pickup location.';
  end if;
  if (
    select count(*)
    from public.deliveries as delivery
    where delivery.assigned_rider_id = request_row.rider_id
      and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
  ) >= rider_capacity then
    raise exception using errcode = '42501', message = 'The rider has reached their active delivery capacity.';
  end if;

  chosen_destination := coalesce(nullif(btrim(destination), ''), selected_quote.delivery_destination, request_row.destination);
  if chosen_destination is null or length(chosen_destination) not between 2 and 240 then
    raise exception using errcode = '22023', message = 'Enter a delivery destination before accepting the quote.';
  end if;

  insert into public.orders (
    customer_id, delivery_partner_id, status, delivery_location, total_amount,
    pickup_location_id, delivery_fee, accepted_quote_id
  )
  values (
    request_row.customer_id,
    request_row.rider_id,
    'accepted',
    btrim(chosen_destination),
    selected_quote.total_amount,
    request_row.pickup_location_id,
    selected_quote.delivery_fee,
    selected_quote.id
  )
  returning id into order_uuid;

  insert into public.order_items (order_id, product_name, unit_price, quantity)
  select order_uuid, item.item_name, item.unit_price, item.quantity
  from public.quote_items as item
  where item.quote_id = selected_quote.id;

  insert into public.deliveries (order_id, assigned_rider_id, pickup_location, destination, status)
  select order_uuid, request_row.rider_id, pickup.name, btrim(chosen_destination), 'accepted'
  from public.pickup_locations as pickup
  where pickup.id = request_row.pickup_location_id;

  update public.quotes set status = 'accepted', updated_at = now() where id = selected_quote.id;
  update public.quotes set status = 'superseded', updated_at = now()
  where request_id = selected_quote.request_id and id <> selected_quote.id and status = 'proposed';
  update public.delivery_requests
  set status = 'accepted', destination = btrim(chosen_destination), updated_at = now()
  where conversation_id = selected_quote.request_id;
  update public.conversations set updated_at = now() where id = selected_quote.request_id;

  return order_uuid;
end;
$$;

create or replace function public.update_pickup_order_status(order_uuid uuid, next_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  selected_order public.orders%rowtype;
  current_delivery_status text;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if next_status is null or next_status not in ('collecting', 'collected', 'on_the_way', 'delivered', 'cancelled') then
    raise exception using errcode = '22023', message = 'That delivery status transition is not supported.';
  end if;

  select * into selected_order
  from public.orders as customer_order
  where customer_order.id = order_uuid and customer_order.accepted_quote_id is not null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This pickup order is unavailable.';
  end if;

  select delivery.status into current_delivery_status
  from public.deliveries as delivery
  where delivery.order_id = order_uuid and delivery.assigned_rider_id = selected_order.delivery_partner_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'This pickup order has no assigned rider.';
  end if;

  if next_status = 'cancelled' then
    if user_id not in (selected_order.customer_id, selected_order.delivery_partner_id)
      or current_delivery_status not in ('accepted', 'collecting')
    then
      raise exception using errcode = '42501', message = 'This pickup order can no longer be cancelled.';
    end if;
  elsif user_id <> selected_order.delivery_partner_id
    or not (
      (current_delivery_status = 'accepted' and next_status = 'collecting')
      or (current_delivery_status = 'collecting' and next_status = 'collected')
      or (current_delivery_status = 'collected' and next_status = 'on_the_way')
      or (current_delivery_status = 'on_the_way' and next_status = 'delivered')
    )
  then
    raise exception using errcode = '42501', message = 'This delivery status transition is not allowed.';
  end if;

  update public.deliveries
  set status = next_status,
      updated_at = now(),
      completed_at = case when next_status = 'delivered' then now() else completed_at end
  where order_id = order_uuid;
  update public.orders set status = next_status, updated_at = now() where id = order_uuid;
  update public.delivery_requests as request
  set status = case when next_status = 'cancelled' then 'cancelled' else request.status end,
      updated_at = now()
  from public.orders as customer_order
  where customer_order.id = order_uuid
    and customer_order.accepted_quote_id is not null
    and request.conversation_id = (
      select quote.request_id from public.quotes as quote where quote.id = customer_order.accepted_quote_id
    );
  if next_status in ('delivered', 'cancelled') then
    update public.conversations
    set status = 'closed', updated_at = now()
    where id = (
      select quote.request_id from public.quotes as quote where quote.id = selected_order.accepted_quote_id
    );
  end if;
  return next_status;
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
  rider_capacity integer;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  select rider.delivery_capacity into rider_capacity
  from public.rider_profiles as rider
  where rider.id = user_id and rider.is_active and rider.is_available
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Go online before accepting a delivery.';
  end if;
  if (
    select count(*)
    from public.deliveries as delivery
    where delivery.assigned_rider_id = user_id
      and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
  ) >= rider_capacity then
    raise exception using errcode = '42501', message = 'Your active delivery capacity is full.';
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
      where customer_order.id = delivery.order_id
        and customer_order.customer_id <> user_id
        and customer_order.accepted_quote_id is null
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
        and customer_order.accepted_quote_id is null
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
      join public.orders as customer_order on customer_order.id = delivery.order_id
      where delivery.assigned_rider_id = user_id
        and delivery.status in ('accepted', 'picked_up')
        and customer_order.accepted_quote_id is null
    ), '[]'::jsonb),
    'completed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', delivery.id,
        'order_id', delivery.order_id,
        'destination', delivery.destination,
        'completed_at', delivery.completed_at
      ) order by delivery.completed_at desc)
      from public.deliveries as delivery
      join public.orders as customer_order on customer_order.id = delivery.order_id
      where delivery.assigned_rider_id = user_id
        and delivery.status = 'delivered'
        and customer_order.accepted_quote_id is null
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
  where delivery.id = delivery_uuid
    and delivery.assigned_rider_id = user_id
    and exists (
      select 1 from public.orders as customer_order
      where customer_order.id = delivery.order_id and customer_order.accepted_quote_id is null
    )
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

revoke all on function public.set_rider_pickup_availability(text[], boolean) from public, anon;
revoke all on function public.list_available_pickup_riders(text) from public, anon;
revoke all on function public.get_my_rider_pickup_settings() from public, anon;
revoke all on function public.open_pickup_conversation(text, uuid) from public, anon;
revoke all on function public.get_my_pickup_conversations() from public, anon;
revoke all on function public.send_pickup_message(uuid, text) from public, anon;
revoke all on function public.create_pickup_quote(uuid, jsonb, text, integer) from public, anon;
revoke all on function public.respond_to_pickup_quote(uuid, boolean, text) from public, anon;
revoke all on function public.update_pickup_order_status(uuid, text) from public, anon;
grant execute on function public.set_rider_pickup_availability(text[], boolean) to authenticated;
grant execute on function public.list_available_pickup_riders(text) to authenticated;
grant execute on function public.get_my_rider_pickup_settings() to authenticated;
grant execute on function public.open_pickup_conversation(text, uuid) to authenticated;
grant execute on function public.get_my_pickup_conversations() to authenticated;
grant execute on function public.send_pickup_message(uuid, text) to authenticated;
grant execute on function public.create_pickup_quote(uuid, jsonb, text, integer) to authenticated;
grant execute on function public.respond_to_pickup_quote(uuid, boolean, text) to authenticated;
grant execute on function public.update_pickup_order_status(uuid, text) to authenticated;

do $$
declare
  realtime_table text;
begin
  foreach realtime_table in array array['messages', 'quotes', 'delivery_requests', 'orders', 'deliveries']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = realtime_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', realtime_table);
    end if;
  end loop;
end;
$$;
