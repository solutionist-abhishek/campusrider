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
  if delivery_fees is null or jsonb_typeof(delivery_fees) <> 'object' then
    raise exception using errcode = '22023', message = 'Provide valid delivery fees for the supported pickup locations.';
  end if;
  if (select count(*) from jsonb_object_keys(delivery_fees)) > 3 then
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
