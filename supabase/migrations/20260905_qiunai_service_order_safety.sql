begin;
create table if not exists public.bot_service_order_flows (
  organization_code text not null,
  flow_id text not null,
  payload jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  primary key (organization_code, flow_id)
);
alter table public.bot_service_order_flows enable row level security;
revoke all on public.bot_service_order_flows from anon, authenticated;
grant all on public.bot_service_order_flows to service_role;

alter table public.play_orders add column if not exists service_flow_key text;
create unique index if not exists play_orders_service_flow_key_unique
  on public.play_orders(guild_id, service_flow_key) where service_flow_key is not null;

create or replace function public.qiunai_transition_unpaid_orders(
  p_guild_id text, p_action text, p_order_id uuid default null, p_group_id text default null
) returns setof public.play_orders language plpgsql set search_path = public as $$
declare
  row_order public.play_orders%rowtype;
  ids uuid[] := '{}';
  eligible boolean := true;
begin
  if p_action not in ('confirm', 'confirm_waiting', 'cancel') or
      (p_order_id is null) = (p_group_id is null) then
    raise exception 'invalid order transition';
  end if;
  for row_order in select * from public.play_orders
    where guild_id = p_guild_id and ((p_order_id is not null and id = p_order_id)
      or (p_group_id is not null and order_group_id = p_group_id)) order by id for update
  loop
    ids := array_append(ids, row_order.id);
    if coalesce(row_order.paid, false) or coalesce(row_order.is_deleted, false)
      or row_order.status is null or row_order.status not in ('quoted', 'waiting_payment', 'waiting_confirm') then
      eligible := false;
    end if;
  end loop;
  if not eligible or cardinality(ids) = 0 then return; end if;
  return query update public.play_orders set
    paid = case when p_action = 'cancel' then paid else true end,
    paid_at = case when p_action = 'cancel' then paid_at else now() end,
    status = case p_action when 'cancel' then 'cancelled' when 'confirm_waiting' then 'waiting_confirm' else 'pending' end,
    quote_status = case p_action when 'cancel' then 'cancelled' when 'confirm_waiting' then quote_status else 'dispatched' end,
    updated_at = now()
    where id = any(ids) returning *;
end;
$$;
revoke all on function public.qiunai_transition_unpaid_orders(text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.qiunai_transition_unpaid_orders(text,text,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;
