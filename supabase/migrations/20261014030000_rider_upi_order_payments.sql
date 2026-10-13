alter table public.rider_profiles
  add column upi_id text check (upi_id is null or length(btrim(upi_id)) between 3 and 320),
  add column payment_qr_path text,
  add column payment_enabled boolean not null default false;

alter table public.orders
  add column payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'payment_reported', 'paid')),
  add column payment_reported_at timestamptz,
  add column payment_confirmed_at timestamptz,
  add column payment_confirmed_by uuid references public.profiles (id),
  add constraint orders_payment_timestamps_match_status check (
    (payment_status = 'unpaid'
      and payment_reported_at is null
      and payment_confirmed_at is null
      and payment_confirmed_by is null)
    or (payment_status = 'payment_reported'
      and payment_reported_at is not null
      and payment_confirmed_at is null
      and payment_confirmed_by is null)
    or (payment_status = 'paid'
      and payment_reported_at is not null
      and payment_confirmed_at is not null
      and payment_confirmed_by is not null)
  );

create table public.order_payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  actor_id uuid not null references public.profiles (id),
  previous_status text check (previous_status is null or previous_status in ('unpaid', 'payment_reported', 'paid')),
  new_status text not null check (new_status in ('unpaid', 'payment_reported', 'paid')),
  created_at timestamptz not null default now()
);

create index order_payment_events_order_created_idx
  on public.order_payment_events (order_id, created_at);

alter table public.order_payment_events enable row level security;
revoke all on public.order_payment_events from anon, authenticated;
grant select on public.order_payment_events to authenticated;

create policy "Order participants can read payment history"
on public.order_payment_events for select to authenticated
using (
  (select public.is_verified_nitsri_user())
  and exists (
    select 1
    from public.orders as customer_order
    where customer_order.id = order_payment_events.order_id
      and (
        customer_order.customer_id = (select auth.uid())
        or customer_order.delivery_partner_id = (select auth.uid())
      )
  )
);

create or replace function public.record_order_payment_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.accepted_quote_id is not null then
    insert into public.order_payment_events (order_id, actor_id, previous_status, new_status)
    values (new.id, coalesce(auth.uid(), new.customer_id), null, new.payment_status);
  elsif tg_op = 'UPDATE'
    and new.accepted_quote_id is not null
    and new.payment_status is distinct from old.payment_status
  then
    insert into public.order_payment_events (order_id, actor_id, previous_status, new_status)
    values (new.id, auth.uid(), old.payment_status, new.payment_status);
  end if;
  return new;
end;
$$;

revoke all on function public.record_order_payment_status_change() from public, anon, authenticated;
create trigger record_order_payment_status_change
after insert or update of payment_status on public.orders
for each row execute function public.record_order_payment_status_change();

insert into public.order_payment_events (order_id, actor_id, previous_status, new_status)
select customer_order.id, customer_order.customer_id, null, customer_order.payment_status
from public.orders as customer_order
where customer_order.accepted_quote_id is not null
  and not exists (
    select 1 from public.order_payment_events as event
    where event.order_id = customer_order.id
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rider-payment-qr',
  'rider-payment-qr',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_read_rider_payment_qr(object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select public.is_verified_nitsri_user())
    and object_path ~ '^[0-9a-fA-F-]{36}/payment-qr$'
    and exists (
      select 1
      from public.orders as customer_order
      join public.rider_profiles as rider
        on rider.id = customer_order.delivery_partner_id
      where customer_order.delivery_partner_id::text = split_part(object_path, '/', 1)
        and rider.payment_enabled
        and rider.payment_qr_path = object_path
        and customer_order.customer_id = (select auth.uid())
        and customer_order.accepted_quote_id is not null
        and customer_order.status <> 'cancelled'
    );
$$;

revoke all on function public.can_read_rider_payment_qr(text) from public, anon;
grant execute on function public.can_read_rider_payment_qr(text) to authenticated;

create policy "Riders and their customers can read payment QR"
on storage.objects for select to authenticated
using (
  bucket_id = 'rider-payment-qr'
  and (
    name = (select auth.uid())::text || '/payment-qr'
    or (select public.can_read_rider_payment_qr(name))
  )
);

create policy "Riders can upload their own payment QR"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'rider-payment-qr'
  and name = (select auth.uid())::text || '/payment-qr'
  and (select public.is_verified_nitsri_user())
);

create policy "Riders can replace their own payment QR"
on storage.objects for update to authenticated
using (
  bucket_id = 'rider-payment-qr'
  and name = (select auth.uid())::text || '/payment-qr'
  and (select public.is_verified_nitsri_user())
)
with check (
  bucket_id = 'rider-payment-qr'
  and name = (select auth.uid())::text || '/payment-qr'
  and (select public.is_verified_nitsri_user())
);

create policy "Riders can remove their own payment QR"
on storage.objects for delete to authenticated
using (
  bucket_id = 'rider-payment-qr'
  and name = (select auth.uid())::text || '/payment-qr'
  and (select public.is_verified_nitsri_user())
);

create or replace function public.get_my_rider_payment_settings()
returns table (
  upi_id text,
  payment_qr_path text,
  payment_enabled boolean
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

  return query
  select rider.upi_id, rider.payment_qr_path, rider.payment_enabled
  from public.rider_profiles as rider
  where rider.id = (select auth.uid());
end;
$$;

create or replace function public.save_my_rider_payment_settings(
  configured_upi_id text,
  enable_payments boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  normalized_upi_id text := nullif(btrim(configured_upi_id), '');
  qr_exists boolean;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;
  if enable_payments is null then
    raise exception using errcode = '22023', message = 'Choose whether to enable UPI payments.';
  end if;
  if normalized_upi_id is not null
    and (
      length(normalized_upi_id) > 320
      or normalized_upi_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,255}@[A-Za-z][A-Za-z0-9.-]{0,63}$'
    )
  then
    raise exception using errcode = '22023', message = 'Enter a valid UPI ID or leave it blank.';
  end if;

  select exists (
    select 1 from storage.objects as object
    where object.bucket_id = 'rider-payment-qr'
      and object.name = user_id::text || '/payment-qr'
  ) into qr_exists;

  if enable_payments and normalized_upi_id is null and not qr_exists then
    raise exception using errcode = '22023', message = 'Add a UPI ID or upload a QR image before enabling payments.';
  end if;

  insert into public.rider_profiles (id, upi_id, payment_qr_path, payment_enabled)
  values (
    user_id,
    normalized_upi_id,
    case when qr_exists then user_id::text || '/payment-qr' else null end,
    enable_payments
  )
  on conflict (id) do update
  set upi_id = excluded.upi_id,
      payment_qr_path = excluded.payment_qr_path,
      payment_enabled = excluded.payment_enabled,
      updated_at = now();

  return enable_payments;
end;
$$;

create or replace function public.get_pickup_order_payment_details(order_uuid uuid)
returns table (
  order_id uuid,
  order_status text,
  total_amount text,
  item_subtotal text,
  delivery_fee text,
  payment_status text,
  payment_reported_at timestamptz,
  payment_confirmed_at timestamptz,
  rider_id uuid,
  rider_name text,
  rider_upi_id text,
  rider_qr_path text
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
  select customer_order.id,
         customer_order.status,
         customer_order.total_amount::text,
         accepted_quote.item_subtotal::text,
         customer_order.delivery_fee::text,
         customer_order.payment_status,
         customer_order.payment_reported_at,
         customer_order.payment_confirmed_at,
         rider.id,
         rider_profile.full_name,
         case when rider.payment_enabled then rider.upi_id else null end,
         case when rider.payment_enabled then rider.payment_qr_path else null end
  from public.orders as customer_order
  join public.rider_profiles as rider
    on rider.id = customer_order.delivery_partner_id
  join public.profiles as rider_profile
    on rider_profile.id = rider.id
  join public.quotes as accepted_quote
    on accepted_quote.id = customer_order.accepted_quote_id
   and accepted_quote.status = 'accepted'
  where customer_order.id = order_uuid
    and customer_order.accepted_quote_id is not null
    and customer_order.status <> 'cancelled'
    and (customer_order.customer_id = user_id or customer_order.delivery_partner_id = user_id);
end;
$$;

create or replace function public.report_pickup_order_payment(order_uuid uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  reported_at timestamptz;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  update public.orders as customer_order
  set payment_status = 'payment_reported',
      payment_reported_at = now()
  where customer_order.id = order_uuid
    and customer_order.customer_id = user_id
    and customer_order.accepted_quote_id is not null
    and customer_order.status <> 'cancelled'
    and customer_order.payment_status = 'unpaid'
  returning customer_order.payment_reported_at into reported_at;

  if not found then
    raise exception using errcode = '42501', message = 'Only the customer can report an unpaid, active pickup order.';
  end if;
  return reported_at;
end;
$$;

create or replace function public.confirm_pickup_order_payment(order_uuid uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_id uuid := auth.uid();
  confirmed_at timestamptz;
begin
  if user_id is null or not public.is_verified_nitsri_user() then
    raise exception using errcode = '42501', message = 'A verified NIT Srinagar account is required.';
  end if;

  update public.orders as customer_order
  set payment_status = 'paid',
      payment_confirmed_at = now(),
      payment_confirmed_by = user_id
  where customer_order.id = order_uuid
    and customer_order.delivery_partner_id = user_id
    and customer_order.accepted_quote_id is not null
    and customer_order.status <> 'cancelled'
    and customer_order.payment_status = 'payment_reported'
  returning customer_order.payment_confirmed_at into confirmed_at;

  if not found then
    raise exception using errcode = '42501', message = 'Only the assigned rider can confirm a customer-reported payment.';
  end if;
  return confirmed_at;
end;
$$;

revoke all on function public.get_my_rider_payment_settings() from public, anon;
revoke all on function public.save_my_rider_payment_settings(text, boolean) from public, anon;
revoke all on function public.get_pickup_order_payment_details(uuid) from public, anon;
revoke all on function public.report_pickup_order_payment(uuid) from public, anon;
revoke all on function public.confirm_pickup_order_payment(uuid) from public, anon;
grant execute on function public.get_my_rider_payment_settings() to authenticated;
grant execute on function public.save_my_rider_payment_settings(text, boolean) to authenticated;
grant execute on function public.get_pickup_order_payment_details(uuid) to authenticated;
grant execute on function public.report_pickup_order_payment(uuid) to authenticated;
grant execute on function public.confirm_pickup_order_payment(uuid) to authenticated;
