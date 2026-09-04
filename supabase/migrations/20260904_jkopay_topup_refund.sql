alter table public.jkopay_topup_orders
  drop constraint if exists jkopay_topup_orders_status_check;

alter table public.jkopay_topup_orders
  add constraint jkopay_topup_orders_status_check
  check (status in ('pending', 'paid', 'failed', 'refunding', 'refunded'));

create or replace function public.prepare_jkopay_topup_refund(
  p_platform_order_id text,
  p_refund_amount integer,
  p_refund_request jsonb default '{}'::jsonb,
  p_requested_by text default null
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
  if payment.status = 'refunded' then
    select coalesce(coins, 0) into final_balance
    from public.users where user_id = payment.user_id;
    return jsonb_build_object(
      'already_processed', true,
      'balance', coalesce(final_balance, 0),
      'refund_result', payment.raw_result #> '{refund,response}'
    );
  end if;
  if payment.status = 'refunding' then
    raise exception 'JKOPAY_REFUND_PENDING';
  end if;
  if payment.status <> 'paid' then
    raise exception 'JKOPAY_ORDER_NOT_REFUNDABLE';
  end if;
  if p_refund_amount <> payment.amount then
    raise exception 'JKOPAY_FULL_REFUND_REQUIRED';
  end if;

  select coalesce(coins, 0) into final_balance
  from public.users
  where user_id = payment.user_id
  for update;
  if not found then
    raise exception 'JKOPAY_USER_NOT_FOUND';
  end if;
  if final_balance < p_refund_amount then
    raise exception 'JKOPAY_ASD_BALANCE_INSUFFICIENT';
  end if;

  update public.users
  set coins = coalesce(coins, 0) - p_refund_amount
  where user_id = payment.user_id
  returning coins into final_balance;

  insert into public.wallet_logs (user_id, type, amount, balance, note)
  values (
    payment.user_id,
    '街口退款',
    -p_refund_amount,
    final_balance,
    '💳 街口支付退款 ASD 回沖｜' || payment.topup_no
  );

  update public.jkopay_topup_orders
  set status = 'refunding',
      raw_result = jsonb_set(
        coalesce(raw_result, '{}'::jsonb),
        '{refund}',
        jsonb_build_object(
          'request', coalesce(p_refund_request, '{}'::jsonb),
          'requested_by', p_requested_by,
          'prepared_at', now()
        ),
        true
      ),
      updated_at = now()
  where id = payment.id;

  return jsonb_build_object(
    'already_processed', false,
    'balance', final_balance
  );
end;
$$;

create or replace function public.cancel_jkopay_topup_refund(
  p_platform_order_id text,
  p_refund_result jsonb default '{}'::jsonb
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
  if payment.status = 'paid' then
    select coalesce(coins, 0) into final_balance
    from public.users where user_id = payment.user_id;
    return jsonb_build_object('already_processed', true, 'balance', coalesce(final_balance, 0));
  end if;
  if payment.status <> 'refunding' then
    raise exception 'JKOPAY_REFUND_NOT_PENDING';
  end if;

  update public.users
  set coins = coalesce(coins, 0) + payment.amount
  where user_id = payment.user_id
  returning coins into final_balance;

  insert into public.wallet_logs (user_id, type, amount, balance, note)
  values (
    payment.user_id,
    '街口退款取消',
    payment.amount,
    final_balance,
    '💳 街口退款未成立，恢復 ASD｜' || payment.topup_no
  );

  update public.jkopay_topup_orders
  set status = 'paid',
      raw_result = jsonb_set(
        coalesce(raw_result, '{}'::jsonb),
        '{refund}',
        coalesce(raw_result #> '{refund}', '{}'::jsonb) || jsonb_build_object(
          'response', coalesce(p_refund_result, '{}'::jsonb),
          'cancelled_at', now()
        ),
        true
      ),
      updated_at = now()
  where id = payment.id;

  return jsonb_build_object('already_processed', false, 'balance', final_balance);
end;
$$;

create or replace function public.complete_jkopay_topup_refund(
  p_platform_order_id text,
  p_refund_result jsonb default '{}'::jsonb
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
  select coalesce(coins, 0) into final_balance
  from public.users where user_id = payment.user_id;
  if payment.status = 'refunded' then
    return jsonb_build_object('already_processed', true, 'balance', coalesce(final_balance, 0));
  end if;
  if payment.status <> 'refunding' then
    raise exception 'JKOPAY_REFUND_NOT_PENDING';
  end if;

  update public.jkopay_topup_orders
  set status = 'refunded',
      raw_result = jsonb_set(
        coalesce(raw_result, '{}'::jsonb),
        '{refund}',
        coalesce(raw_result #> '{refund}', '{}'::jsonb) || jsonb_build_object(
          'response', coalesce(p_refund_result, '{}'::jsonb),
          'completed_at', now()
        ),
        true
      ),
      updated_at = now()
  where id = payment.id;

  return jsonb_build_object('already_processed', false, 'balance', coalesce(final_balance, 0));
end;
$$;

revoke all on function public.prepare_jkopay_topup_refund(text, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.cancel_jkopay_topup_refund(text, jsonb) from public, anon, authenticated;
revoke all on function public.complete_jkopay_topup_refund(text, jsonb) from public, anon, authenticated;

grant execute on function public.prepare_jkopay_topup_refund(text, integer, jsonb, text) to service_role;
grant execute on function public.cancel_jkopay_topup_refund(text, jsonb) to service_role;
grant execute on function public.complete_jkopay_topup_refund(text, jsonb) to service_role;
