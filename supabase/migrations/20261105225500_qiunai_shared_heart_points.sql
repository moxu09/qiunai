begin;
set local lock_timeout = '5s';

-- Keep directional gift events and share the balance across both rows.
-- Serialize heart writes because one checkout can settle several pairs in one transaction.

create or replace function public.qiunai_apply_heart_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  checkout public.qiunai_heart_checkouts%rowtype;
  pair public.qiunai_heart_pairs%rowtype;
  allocation jsonb;
  award integer;
  v_event_id bigint;
  previous bigint;
  verified boolean;
  refund_remainder bigint;
begin
  if new.guild_id is distinct from '1206138511535898654'
    or coalesce(new.order_group_id, '') not like 'heart:%' then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.paid is not true or new.is_deleted is true or new.status = 'cancelled') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qiunai-heart-ledger', 0));
    update public.qiunai_heart_events set reversed_at = now()
      where order_id = new.id::text and reversed_at is null
      returning id, buyer_id, staff_id, points into v_event_id, pair.buyer_id, pair.staff_id, award;
    if v_event_id is not null then
      select greatest(0, award - balance_points) into strict refund_remainder
        from public.qiunai_heart_pairs where buyer_id = pair.buyer_id and staff_id = pair.staff_id;
      update public.qiunai_heart_pairs
        set earned_points = earned_points - award,
            manual_points = greatest(manual_points, award - opening_points - earned_points)
        where buyer_id = pair.buyer_id and staff_id = pair.staff_id;
      if refund_remainder > 0 then
        update public.qiunai_heart_pairs
          set manual_points = balance_points - least(refund_remainder, balance_points) - opening_points - earned_points
          where buyer_id = pair.staff_id and staff_id = pair.buyer_id and balance_points > 0;
      end if;
      update public.qiunai_heart_delivery set done_at = now(), lease_owner = null, lease_until = null
        where event_id = v_event_id and done_at is null;
    end if;
    return new;
  end if;
  if new.paid is distinct from true or new.is_deleted is true
    or new.status is distinct from 'completed' or new.order_type is distinct from '打賞' then
    return new;
  end if;
  select * into checkout from public.qiunai_heart_checkouts
    where flow_id = substr(new.order_group_id, 7);
  if not found or checkout.buyer_id is distinct from new.customer_id
    or checkout.channel_id is distinct from new.channel_id then
    raise exception '心動值打賞缺少相符的付款資料';
  end if;
  select value into allocation from jsonb_array_elements(checkout.allocations)
    where value->>'staffId' = new.assigned_player;
  award := (allocation->>'amount')::integer;
  if award is null or award <= 0 or award is distinct from new.final_price
    or allocation->>'item' is distinct from new.order_item then
    raise exception '心動值打賞明細與付款資料不一致';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qiunai-heart-ledger', 0));
  insert into public.qiunai_heart_pairs(buyer_id, staff_id)
    values(checkout.buyer_id, new.assigned_player) on conflict do nothing;
  select * into pair from public.qiunai_heart_pairs
    where buyer_id = checkout.buyer_id and staff_id = new.assigned_player for update;
  select coalesce(sum(balance_points), 0), coalesce(bool_or(opening_verified_at is not null), false)
    into previous, verified from public.qiunai_heart_pairs
    where (buyer_id, staff_id) in ((pair.buyer_id, pair.staff_id), (pair.staff_id, pair.buyer_id));
  insert into public.qiunai_heart_events(order_id, flow_id, buyer_id, staff_id,
      points, previous_total, total, lines, broadcast, anonymous, opening_verified)
    values(new.id::text, checkout.flow_id, pair.buyer_id, pair.staff_id, award,
      previous, previous + award,
      allocation->'lines', checkout.broadcast, checkout.anonymous, verified)
    on conflict do nothing returning id into v_event_id;
  if v_event_id is null then return new; end if;
  update public.qiunai_heart_pairs set earned_points = earned_points + award
    where buyer_id = pair.buyer_id and staff_id = pair.staff_id;
  insert into public.qiunai_heart_delivery(event_id, kind)
    select v_event_id, kind from unnest(array['buyer_roles','staff_roles','broadcast']) jobs(kind);
  return new;
end $$;

create or replace function public.qiunai_adjust_heart_points(
  p_interaction_id text, p_actor_id text, p_buyer_id text, p_staff_id text,
  p_operation text, p_points integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  audit public.qiunai_heart_adjustments%rowtype;
  previous bigint;
  next_total bigint;
  other_balance bigint;
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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qiunai-heart-ledger', 0));
  insert into public.qiunai_heart_pairs(buyer_id, staff_id)
    values (p_buyer_id, p_staff_id) on conflict do nothing;
  select sum(balance_points),
      coalesce(sum(balance_points) filter (where buyer_id = p_staff_id), 0)
    into previous, other_balance from public.qiunai_heart_pairs
    where (buyer_id, staff_id) in ((p_buyer_id, p_staff_id), (p_staff_id, p_buyer_id));
  next_total := case p_operation
    when 'add' then previous + p_points
    when 'subtract' then previous - p_points
    else p_points
  end;
  if next_total < 0 then
    raise exception using errcode = '22023', message = '扣減數額超過目前心動值';
  end if;

  update public.qiunai_heart_pairs
    set manual_points = greatest(0, next_total - other_balance) - opening_points - earned_points
    where buyer_id = p_buyer_id and staff_id = p_staff_id;
  if next_total < other_balance then
    update public.qiunai_heart_pairs
      set manual_points = next_total - opening_points - earned_points
      where buyer_id = p_staff_id and staff_id = p_buyer_id;
  end if;
  insert into public.qiunai_heart_adjustments
    (interaction_id, actor_id, buyer_id, staff_id, operation, requested_points, previous_points, new_points)
    values (p_interaction_id, p_actor_id, p_buyer_id, p_staff_id, p_operation, p_points, previous, next_total);
  return jsonb_build_object('previous', previous::text, 'total', next_total::text);
end $$;

create or replace function public.qiunai_resolve_heart_opening(
  p_tab text, p_row integer, p_column integer, p_buyer_id text, p_staff_id text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  legacy public.qiunai_heart_legacy_rows%rowtype;
  total bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qiunai-heart-ledger', 0));
  select * into legacy from public.qiunai_heart_legacy_rows
    where (source_tab, source_row, source_column) = (p_tab, p_row, p_column) for update;
  if not found or legacy.archived_at is not null or legacy.buyer_name is null or legacy.staff_name is null or legacy.points is null then
    raise exception '舊表來源缺少完整配對';
  end if;
  if legacy.resolved_at is not null then
    if (legacy.resolved_buyer_id, legacy.resolved_staff_id) is distinct from (p_buyer_id, p_staff_id)
      and (legacy.resolved_buyer_id, legacy.resolved_staff_id) is distinct from (p_staff_id, p_buyer_id) then
      raise exception '此舊表列已確認為其他配對';
    end if;
    select coalesce(sum(balance_points), 0) into total from public.qiunai_heart_pairs
      where (buyer_id, staff_id) in ((p_buyer_id, p_staff_id), (p_staff_id, p_buyer_id));
    return total;
  end if;
  if exists (
    select 1 from public.qiunai_heart_pairs
      where (buyer_id, staff_id) in ((p_buyer_id, p_staff_id), (p_staff_id, p_buyer_id))
        and (opening_verified_at is not null or opening_points > 0)
  ) then
    raise exception '此配對已承接過舊表累積值';
  end if;
  insert into public.qiunai_heart_pairs(buyer_id, staff_id, opening_points, opening_verified_at)
    values(p_buyer_id, p_staff_id, legacy.points, now())
    on conflict (buyer_id, staff_id) do update set
      opening_points = excluded.opening_points, opening_verified_at = excluded.opening_verified_at
      where qiunai_heart_pairs.opening_verified_at is null
    returning balance_points into total;
  if not found then raise exception '此配對已承接過舊表累積值'; end if;
  update public.qiunai_heart_legacy_rows set resolved_buyer_id = p_buyer_id,
    resolved_staff_id = p_staff_id, resolved_at = now()
    where (source_tab, source_row, source_column) = (p_tab, p_row, p_column);
  select coalesce(sum(balance_points), 0) into total from public.qiunai_heart_pairs
    where (buyer_id, staff_id) in ((p_buyer_id, p_staff_id), (p_staff_id, p_buyer_id));
  return total;
end $$;

create or replace function public.qiunai_claim_heart_delivery(p_owner uuid)
returns setof jsonb language sql security definer set search_path = '' as $$
  with candidates as (
    select d.event_id, d.kind from public.qiunai_heart_delivery d
    where d.done_at is null and d.next_attempt_at <= now()
      and (d.lease_until is null or d.lease_until <= now())
      and (d.kind <> 'broadcast' or not exists (
        select 1 from public.qiunai_heart_delivery prior
        join public.qiunai_heart_events prior_event on prior_event.id = prior.event_id
        join public.qiunai_heart_events current_event on current_event.id = d.event_id
        where prior.kind = 'broadcast' and prior.done_at is null and prior.event_id < d.event_id
          and (prior_event.buyer_id, prior_event.staff_id) in (
            (current_event.buyer_id, current_event.staff_id), (current_event.staff_id, current_event.buyer_id)
          )
      ))
    order by d.next_attempt_at, d.event_id, d.kind limit 8 for update skip locked
  ), claimed as (
    update public.qiunai_heart_delivery d set lease_owner = p_owner,
      lease_until = now() + interval '3 minutes', attempts = d.attempts + 1
    from candidates c where (d.event_id, d.kind) = (c.event_id, c.kind)
    returning d.*
  )
  select to_jsonb(e) || to_jsonb(d)
    from claimed d join public.qiunai_heart_events e on e.id = d.event_id
    order by d.event_id, d.kind;
$$;

create function public.qiunai_list_heart_partners(p_user_id text)
returns table (partner_id text, total_points text, opening_verified boolean)
language sql stable set search_path = '' as $$
  select case when buyer_id = p_user_id then staff_id else buyer_id end,
    sum(balance_points)::text, bool_or(opening_verified_at is not null)
  from public.qiunai_heart_pairs
  where buyer_id = p_user_id or staff_id = p_user_id
  group by 1
  having sum(balance_points) > 0;
$$;

revoke all on function public.qiunai_list_heart_partners(text) from public, anon, authenticated;
grant execute on function public.qiunai_list_heart_partners(text) to service_role;

notify pgrst, 'reload schema';
commit;
