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
  where rider.id <> (select auth.uid())
    and rider.is_active
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

create or replace function public.get_pickup_rider_discovery_status(location_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  minimum_fee numeric(10, 2);
  maximum_fee numeric(10, 2);
  verified_other_students integer;
  unverified_other_students integer;
  active_riders integer;
  online_riders integer;
  location_riders integer;
  priced_riders integer;
  available_riders integer;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if location_id is null or location_id not in ('canteen', 'cafeteria', 'gate') then
    raise exception using errcode = '22023', message = 'Choose a supported pickup location.';
  end if;

  select pickup.minimum_rider_delivery_fee, pickup.maximum_rider_delivery_fee
  into minimum_fee, maximum_fee
  from public.pickup_locations as pickup
  where pickup.id = location_id and pickup.is_active;
  if not found then
    raise exception using errcode = '22023', message = 'This pickup location is not active.';
  end if;

  select count(*) filter (where auth_user.email_confirmed_at is not null),
         count(*) filter (where auth_user.email_confirmed_at is null)
  into verified_other_students, unverified_other_students
  from auth.users as auth_user
  where auth_user.id <> user_id
    and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$';

  if verified_other_students = 0 and unverified_other_students > 0 then
    return 'verification_incomplete';
  end if;

  with eligible_riders as materialized (
    select rider.id,
           rider.is_active,
           rider.is_available,
           rider.supported_pickup_locations,
           rider.delivery_capacity,
           case
             when jsonb_typeof(rider.pickup_delivery_fees -> location_id) = 'number'
             then (rider.pickup_delivery_fees ->> location_id)::numeric
             else null
           end as delivery_fee,
           (
             select count(*)::integer
             from public.deliveries as delivery
             where delivery.assigned_rider_id = rider.id
               and delivery.status in ('accepted', 'picked_up', 'collecting', 'collected', 'on_the_way')
           ) as workload
    from public.rider_profiles as rider
    join public.profiles as profile on profile.id = rider.id
    join auth.users as auth_user on auth_user.id = rider.id
    where rider.id <> user_id
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) ~ '^[^[:space:]@]+@nitsri[.]ac[.]in$'
  )
  select count(*) filter (where rider.is_active),
         count(*) filter (where rider.is_active and rider.is_available),
         count(*) filter (
           where rider.is_active
             and rider.is_available
             and location_id = any(rider.supported_pickup_locations)
         ),
         count(*) filter (
           where rider.is_active
             and rider.is_available
             and location_id = any(rider.supported_pickup_locations)
             and maximum_fee is not null
             and rider.delivery_fee between minimum_fee and maximum_fee
         ),
         count(*) filter (
           where rider.is_active
             and rider.is_available
             and location_id = any(rider.supported_pickup_locations)
             and maximum_fee is not null
             and rider.delivery_fee between minimum_fee and maximum_fee
             and rider.workload < rider.delivery_capacity
         )
  into active_riders, online_riders, location_riders, priced_riders, available_riders
  from eligible_riders as rider;

  if active_riders = 0 then
    return 'no_rider_mode';
  elsif online_riders = 0 then
    return 'offline';
  elsif location_riders = 0 then
    return 'location';
  elsif priced_riders = 0 then
    return 'pricing';
  elsif available_riders = 0 then
    return 'capacity';
  end if;

  return 'available';
end;
$$;

revoke all on function public.get_pickup_rider_discovery_status(text) from public, anon;
grant execute on function public.get_pickup_rider_discovery_status(text) to authenticated;
