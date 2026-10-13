insert into public.canteens (name, is_active)
select requested.name, true
from (values ('Gasha Canteen'), ('Cafeteria')) as requested(name)
where not exists (
  select 1
  from public.canteens as canteen
  where lower(canteen.name) = lower(requested.name)
);
