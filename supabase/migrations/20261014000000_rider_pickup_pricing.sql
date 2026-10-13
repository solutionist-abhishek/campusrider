alter table public.pickup_locations
  add column minimum_rider_delivery_fee numeric(10, 2) not null default 0
    check (minimum_rider_delivery_fee >= 0),
  add column maximum_rider_delivery_fee numeric(10, 2)
    check (maximum_rider_delivery_fee is null or maximum_rider_delivery_fee >= minimum_rider_delivery_fee);

alter table public.rider_profiles
  add column pickup_delivery_fees jsonb not null default '{}'::jsonb
    check (jsonb_typeof(pickup_delivery_fees) = 'object');

create or replace function public.save_rider_pickup_settings(
  pickup_locations text[],
  delivery_fees jsonb,
  online boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  saved_fees jsonb;
  updated_fees jsonb;
  fee_entry record;
  fee_amount numeric(10, 2);
  minimum_fee numeric(10, 2);
  maximum_fee numeric(10, 2);
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
  if delivery_fees is null or jsonb_typeof(delivery_fees) <> 'object' or jsonb_object_length(delivery_fees) > 3 then
    raise exception using errcode = '22023', message = 'Provide valid delivery fees for the supported pickup locations.';
  end if;

  select coalesce(rider.pickup_delivery_fees, '{}'::jsonb)
  into saved_fees
  from public.rider_profiles as rider
  where rider.id = user_id;
  updated_fees := coalesce(saved_fees, '{}'::jsonb);

  for fee_entry in
    select entry.key as location_id, entry.value as fee_value
    from jsonb_each(delivery_fees) as entry
  loop
    if fee_entry.location_id not in ('canteen', 'cafeteria', 'gate') then
      raise exception using errcode = '22023', message = 'Choose a valid pickup location for each delivery fee.';
    end if;

    if fee_entry.fee_value = 'null'::jsonb then
      updated_fees := updated_fees - fee_entry.location_id;
      continue;
    end if;
    if jsonb_typeof(fee_entry.fee_value) is distinct from 'number'
      or (fee_entry.fee_value #>> '{}') !~ '^(0|[1-9][0-9]*)([.][0-9]{1,2})?$'
    then
      raise exception using errcode = '22023', message = 'Delivery fees must be non-negative INR amounts with at most two decimal places.';
    end if;

    fee_amount := (fee_entry.fee_value #>> '{}')::numeric;
    if fee_amount > 99999999.99 then
      raise exception using errcode = '22023', message = 'The delivery fee is outside the supported range.';
    end if;

    select pickup.minimum_rider_delivery_fee, pickup.maximum_rider_delivery_fee
    into minimum_fee, maximum_fee
    from public.pickup_locations as pickup
    where pickup.id = fee_entry.location_id and pickup.is_active;
    if not found or maximum_fee is null then
      raise exception using errcode = '22023', message = 'An administrator must configure a maximum rider delivery fee for this pickup location first.';
    end if;
    if fee_amount < minimum_fee or fee_amount > maximum_fee then
      raise exception using errcode = '22023', message = 'The delivery fee is outside the administrator-approved range for this pickup location.';
    end if;

    updated_fees := updated_fees || jsonb_build_object(fee_entry.location_id, fee_amount);
  end loop;

  if online and exists (
    select 1
    from unnest(pickup_locations) as selected(location_id)
    left join public.pickup_locations as pickup
      on pickup.id = selected.location_id and pickup.is_active
    where pickup.id is null
      or pickup.maximum_rider_delivery_fee is null
      or not (updated_fees ? selected.location_id)
      or (updated_fees ->> selected.location_id)::numeric < pickup.minimum_rider_delivery_fee
      or (updated_fees ->> selected.location_id)::numeric > pickup.maximum_rider_delivery_fee
  ) then
    raise exception using errcode = '22023', message = 'Configure an administrator-approved delivery fee for every selected pickup location before going online.';
  end if;

  insert into public.rider_profiles (
    id, is_active, is_available, supported_pickup_locations, pickup_delivery_fees
  )
  values (user_id, true, online, pickup_locations, updated_fees)
  on conflict (id) do update
  set is_active = true,
      is_available = excluded.is_available,
      supported_pickup_locations = excluded.supported_pickup_locations,
      pickup_delivery_fees = excluded.pickup_delivery_fees,
      updated_at = now();

  return online;
end;
$$;

create or replace function public.set_rider_pickup_availability(
  pickup_locations text[],
  online boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.save_rider_pickup_settings(pickup_locations, '{}'::jsonb, online);
end;
$$;

create or replace function public.get_my_rider_pickup_fees()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  saved_fees jsonb;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  select coalesce(rider.pickup_delivery_fees, '{}'::jsonb)
  into saved_fees
  from public.rider_profiles as rider
  where rider.id = user_id;

  return coalesce(saved_fees, '{}'::jsonb);
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
         (rider.pickup_delivery_fees ->> location_id)::numeric
  from public.rider_profiles as rider
  join public.profiles as profile on profile.id = rider.id
  join public.pickup_locations as pickup on pickup.id = location_id and pickup.is_active
  left join public.deliveries as delivery
    on delivery.assigned_rider_id = rider.id
    and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
  where rider.is_active
    and rider.is_available
    and location_id = any(rider.supported_pickup_locations)
    and jsonb_typeof(rider.pickup_delivery_fees -> location_id) = 'number'
    and (rider.pickup_delivery_fees ->> location_id)::numeric between
      pickup.minimum_rider_delivery_fee and pickup.maximum_rider_delivery_fee
    and exists (
      select 1 from auth.users as auth_user
      where auth_user.id = rider.id
        and auth_user.email_confirmed_at is not null
        and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$'
    )
  group by rider.id, profile.full_name, profile.avatar_url, rider.delivery_capacity,
           rider.pickup_delivery_fees, pickup.minimum_rider_delivery_fee, pickup.maximum_rider_delivery_fee
  having count(delivery.id) < rider.delivery_capacity
  order by count(delivery.id), profile.full_name;
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
  minimum_fee numeric(10, 2);
  maximum_fee numeric(10, 2);
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

  select rider.delivery_capacity, (rider.pickup_delivery_fees ->> request_row.pickup_location_id)::numeric
  into rider_capacity, configured_fee
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

  select pickup.minimum_rider_delivery_fee, pickup.maximum_rider_delivery_fee
  into minimum_fee, maximum_fee
  from public.pickup_locations as pickup
  where pickup.id = request_row.pickup_location_id and pickup.is_active;
  if not found or configured_fee is null or maximum_fee is null
    or configured_fee < minimum_fee or configured_fee > maximum_fee
  then
    raise exception using errcode = '22023', message = 'Configure a delivery fee within the administrator-approved range before sending a quote.';
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

update public.quotes
set status = 'superseded', updated_at = now()
where status = 'proposed';

update public.delivery_requests as request
set status = 'pending', updated_at = now()
where request.status = 'quoted'
  and not exists (
    select 1 from public.quotes as quote
    where quote.request_id = request.conversation_id and quote.status = 'proposed'
  );

revoke all on function public.save_rider_pickup_settings(text[], jsonb, boolean) from public, anon;
revoke all on function public.get_my_rider_pickup_fees() from public, anon;
grant execute on function public.save_rider_pickup_settings(text[], jsonb, boolean) to authenticated;
grant execute on function public.get_my_rider_pickup_fees() to authenticated;
