begin;
set local lock_timeout = '5s';

alter table public.qiunai_heart_pairs
  add column manual_points bigint not null default 0,
  add column balance_points bigint generated always as
    (greatest(0::bigint, opening_points + earned_points + manual_points)) stored;

create table public.qiunai_heart_adjustments (
  interaction_id text primary key check (interaction_id ~ '^[0-9]{15,22}$'),
  actor_id text not null check (actor_id ~ '^[0-9]{15,22}$'),
  buyer_id text not null,
  staff_id text not null,
  operation text not null check (operation in ('add', 'subtract', 'set')),
  requested_points integer not null check (requested_points >= 0),
  previous_points bigint not null check (previous_points >= 0),
  new_points bigint not null check (new_points >= 0),
  created_at timestamptz not null default now(),
  foreign key (buyer_id, staff_id) references public.qiunai_heart_pairs
);
alter table public.qiunai_heart_adjustments enable row level security;
revoke all on public.qiunai_heart_adjustments from public, anon, authenticated, service_role;
grant select on public.qiunai_heart_adjustments to service_role;

create function public.qiunai_adjust_heart_points(
  p_interaction_id text, p_actor_id text, p_buyer_id text, p_staff_id text,
  p_operation text, p_points integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  audit public.qiunai_heart_adjustments%rowtype;
  previous bigint;
  next_total bigint;
begin
  if p_interaction_id is null or p_interaction_id !~ '^[0-9]{15,22}$'
    or p_actor_id is null or p_actor_id !~ '^[0-9]{15,22}$'
    or p_buyer_id is null or p_buyer_id !~ '^[0-9]{15,22}$'
    or p_staff_id is null or p_staff_id !~ '^[0-9]{15,22}$'
    or p_buyer_id = p_staff_id
    or p_operation is null or p_operation not in ('add', 'subtract', 'set')
    or p_points is null or p_points < 0 or (p_points = 0 and p_operation <> 'set') then
    raise exception using errcode = '22023', message = '心動值調整資料無效';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_interaction_id, 0));
  select * into audit from public.qiunai_heart_adjustments where interaction_id = p_interaction_id;
  if found then
    if (audit.actor_id, audit.buyer_id, audit.staff_id, audit.operation, audit.requested_points)
      is distinct from (p_actor_id, p_buyer_id, p_staff_id, p_operation, p_points) then
      raise exception using errcode = '22023', message = '心動值調整操作編號衝突';
    end if;
    return jsonb_build_object('previous', audit.previous_points::text, 'total', audit.new_points::text);
  end if;

  insert into public.qiunai_heart_pairs(buyer_id, staff_id)
    values (p_buyer_id, p_staff_id) on conflict do nothing;
  select balance_points into strict previous from public.qiunai_heart_pairs
    where buyer_id = p_buyer_id and staff_id = p_staff_id for update;
  next_total := case p_operation
    when 'add' then previous + p_points
    when 'subtract' then previous - p_points
    else p_points
  end;
  if next_total < 0 then
    raise exception using errcode = '22023', message = '扣減數額超過目前心動值';
  end if;

  update public.qiunai_heart_pairs
    set manual_points = next_total - opening_points - earned_points
    where buyer_id = p_buyer_id and staff_id = p_staff_id;
  insert into public.qiunai_heart_adjustments
    (interaction_id, actor_id, buyer_id, staff_id, operation, requested_points, previous_points, new_points)
    values (p_interaction_id, p_actor_id, p_buyer_id, p_staff_id, p_operation, p_points, previous, next_total);
  return jsonb_build_object('previous', previous::text, 'total', next_total::text);
end $$;
revoke all on function public.qiunai_adjust_heart_points(text,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.qiunai_adjust_heart_points(text,text,text,text,text,integer) to service_role;

-- Keep the deployed settlement and historical import bodies intact outside the balance expressions.
do $$
declare
  definition text;
  old_totals constant text := 'pair.opening_points + pair.earned_points, pair.opening_points + pair.earned_points + award';
  old_refund constant text := 'set earned_points = earned_points - award';
begin
  definition := pg_get_functiondef('public.qiunai_apply_heart_order()'::regprocedure);
  if strpos(definition, old_totals) = 0 or strpos(definition, old_refund) = 0 then
    raise exception '現有心動值付款函式與預期不同';
  end if;
  definition := replace(definition, old_totals, 'pair.balance_points, pair.balance_points + award');
  -- A refund of points already manually removed stops at zero. Future gifts accrue from zero.
  definition := replace(definition, old_refund,
    'set earned_points = earned_points - award, manual_points = greatest(manual_points, award - opening_points - earned_points)');
  execute definition;

  definition := pg_get_functiondef('public.qiunai_resolve_heart_opening(text,integer,integer,text,text)'::regprocedure);
  if strpos(definition, 'opening_points + earned_points into total') = 0 then
    raise exception '現有心動值舊資料函式與預期不同';
  end if;
  execute replace(definition, 'opening_points + earned_points into total', 'balance_points into total');
end $$;

notify pgrst, 'reload schema';
commit;
