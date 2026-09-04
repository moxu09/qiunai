create table if not exists public.jkopay_topup_orders (
  id uuid primary key default gen_random_uuid(),
  platform_order_id text not null unique,
  topup_no text not null unique,
  user_id text not null,
  amount integer not null check (amount > 0),
  currency text not null default 'TWD' check (currency = 'TWD'),
  channel_id text,
  payment_message_id text,
  payment_url text,
  qr_img text,
  qr_timeout bigint,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  trade_no text unique,
  trans_time text,
  raw_result jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.jkopay_topup_orders enable row level security;

create or replace function public.complete_jkopay_topup(
  p_platform_order_id text,
  p_trade_no text,
  p_amount integer,
  p_trans_time text default null,
  p_raw_result jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.jkopay_topup_orders%rowtype;
  final_balance integer;
begin
  select * into payment
  from public.jkopay_topup_orders
  where platform_order_id = p_platform_order_id
  for update;

  if payment.id is null then
    raise exception 'JKOPAY_ORDER_NOT_FOUND';
  end if;
  if payment.amount <> p_amount then
    raise exception 'JKOPAY_AMOUNT_MISMATCH';
  end if;
  if payment.status = 'paid' then
    select coins into final_balance from public.users where user_id = payment.user_id;
    return jsonb_build_object('already_processed', true, 'balance', coalesce(final_balance, 0));
  end if;
  if payment.status <> 'pending' then
    raise exception 'JKOPAY_ORDER_NOT_PAYABLE';
  end if;

  insert into public.users (user_id, coins)
  values (payment.user_id, p_amount)
  on conflict (user_id) do update
    set coins = coalesce(public.users.coins, 0) + excluded.coins
  returning coins into final_balance;

  insert into public.wallet_logs (user_id, type, amount, balance, note)
  values (
    payment.user_id,
    '儲值',
    p_amount,
    final_balance,
    '💳 街口支付自動儲值｜' || payment.topup_no
  );

  update public.jkopay_topup_orders
  set status = 'paid',
      trade_no = p_trade_no,
      trans_time = p_trans_time,
      raw_result = coalesce(p_raw_result, '{}'::jsonb),
      paid_at = now(),
      updated_at = now()
  where id = payment.id;

  return jsonb_build_object('already_processed', false, 'balance', final_balance);
end;
$$;

revoke all on table public.jkopay_topup_orders from anon, authenticated;
revoke all on function public.complete_jkopay_topup(text, text, integer, text, jsonb) from public, anon, authenticated;
grant all on table public.jkopay_topup_orders to service_role;
grant execute on function public.complete_jkopay_topup(text, text, integer, text, jsonb) to service_role;
