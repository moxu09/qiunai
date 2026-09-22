begin;

-- 所有會跨越「資料庫付款」與「Discord 發訊息」的流程，都必須留下可恢復狀態。
alter table public.play_orders add column if not exists dispatch_status text;
alter table public.play_orders add column if not exists dispatch_attempts integer not null default 0;
alter table public.play_orders add column if not exists dispatch_claimed_at timestamptz;
alter table public.play_orders add column if not exists dispatch_last_error text;
alter table public.play_orders add column if not exists dispatch_message_id text;
alter table public.play_orders add column if not exists dispatch_control_message_id text;
alter table public.play_orders add column if not exists dispatched_at timestamptz;

-- 舊單採保守策略：已進入派單狀態的舊資料視為已送，避免 migration 上線時重送。
update public.play_orders
set dispatch_status = case
  -- accepted/completed 已有後續人員操作，可安全視為真的送達。
  when coalesce(paid, false) and status in ('accepted', 'completed') then 'dispatched'
  -- 舊版 quote_status=dispatched 只代表程式準備派單，不足以證明 Discord
  -- 訊息真的送達。列入 recovery，worker 會先以 deterministic custom id
  -- 找舊訊息，找不到才補送，避免把歷史事故永久排除。
  when coalesce(paid, false) and (
    quote_status = 'dispatched' or status = 'pending'
  ) then 'pending'
  else 'not_ready'
end
where dispatch_status is null
  and guild_id = '1206138511535898654';

-- dispatch_status 是 shared schema 欄位。非秋奈列只補中立預設，不能套用
-- 秋奈的業務判斷；各店 migration 需按自己的 guild 從 not_ready 明確重算。
update public.play_orders
set dispatch_status = 'not_ready'
where dispatch_status is null;

alter table public.play_orders alter column dispatch_status set default 'not_ready';
alter table public.play_orders alter column dispatch_status set not null;
alter table public.play_orders drop constraint if exists play_orders_dispatch_status_check;
alter table public.play_orders add constraint play_orders_dispatch_status_check
  check (dispatch_status in ('not_ready', 'pending', 'processing', 'dispatched', 'failed'));
create index if not exists play_orders_dispatch_recovery_idx
  on public.play_orders(dispatch_status, dispatch_claimed_at)
  where coalesce(paid, false) and dispatch_status in ('pending', 'processing', 'failed');

create table if not exists public.bot_financial_operations (
  organization_code text not null,
  operation_key text not null,
  operation_type text not null,
  entity_id text,
  actor_id text,
  amount numeric not null default 0,
  status text not null default 'completed',
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_code, operation_key),
  check (status in ('processing', 'completed', 'failed'))
);
alter table public.bot_financial_operations add column if not exists effects_status text not null default 'pending';
alter table public.bot_financial_operations add column if not exists effects_attempts integer not null default 0;
alter table public.bot_financial_operations add column if not exists effects_claimed_at timestamptz;
alter table public.bot_financial_operations add column if not exists effects_completed_at timestamptz;
alter table public.bot_financial_operations add column if not exists effects_last_error text;
alter table public.bot_financial_operations drop constraint if exists bot_financial_operations_effects_status_check;
alter table public.bot_financial_operations add constraint bot_financial_operations_effects_status_check
  check (effects_status in ('pending', 'processing', 'completed', 'failed'));
alter table public.bot_financial_operations enable row level security;
revoke all on public.bot_financial_operations from public, anon, authenticated;
grant all on public.bot_financial_operations to service_role;

-- VIP 累積本身也需要交易內的冪等鍵。bot_financial_operations 的 effects_status
-- 只能保證背景工作會重跑；若程序在 VIP 加總後、complete 前中斷，仍可能重複加總。
create table if not exists public.bot_vip_effects (
  organization_code text not null,
  operation_key text not null,
  guild_id text not null,
  user_id text not null,
  trigger_type text not null check (trigger_type in ('topup', 'spend')),
  amount integer not null,
  applied_at timestamptz not null default now(),
  primary key (organization_code, operation_key)
);
alter table public.bot_vip_effects enable row level security;
revoke all on public.bot_vip_effects from public, anon, authenticated;
grant all on public.bot_vip_effects to service_role;

-- 每一級 VIP 獎勵都有自己的持久操作。ASD、錢包明細、優惠券及升等紀錄
-- 由單一 RPC 一次提交；Discord 身分組/通知另以 attempt fencing 重試。
create table if not exists public.bot_vip_reward_operations (
  organization_code text not null,
  guild_id text not null,
  user_id text not null,
  level_key text not null,
  old_level_key text,
  trigger_type text,
  trigger_amount integer not null default 0,
  reward_asd integer not null default 0,
  reward_coupons jsonb not null default '[]'::jsonb,
  reward_note text,
  role_id text,
  level_name text,
  final_balance integer,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'processing', 'completed', 'failed')),
  delivery_attempts integer not null default 0,
  delivery_claimed_at timestamptz,
  delivery_completed_at timestamptz,
  delivery_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_code, guild_id, user_id, level_key)
);
alter table public.bot_vip_reward_operations enable row level security;
revoke all on public.bot_vip_reward_operations from public, anon, authenticated;
grant all on public.bot_vip_reward_operations to service_role;

-- 已存在的 VIP 列/升等紀錄代表舊版獎勵已處理；先建立 completed 標記，
-- 避免新可重入流程首次執行時把歷史級別全部再發一次。
insert into public.bot_vip_reward_operations(
  organization_code, guild_id, user_id, level_key, level_name,
  reward_asd, reward_note, role_id, delivery_status, delivery_completed_at
)
select distinct on (v.guild_id, v.user_id, l.level_key)
  'qiunai', v.guild_id, v.user_id, l.level_key, l.level_name,
  coalesce(l.reward_asd, 0), l.reward_note, l.role_id, 'completed', now()
from public.user_vips v
join public.vip_levels current_level
  on current_level.guild_id = v.guild_id and current_level.level_key = v.level_key
join public.vip_levels l
  on l.guild_id = v.guild_id and l.sort_order <= current_level.sort_order
where v.guild_id = '1206138511535898654' and v.user_id is not null
on conflict (organization_code, guild_id, user_id, level_key) do nothing;

insert into public.bot_vip_reward_operations(
  organization_code, guild_id, user_id, level_key, old_level_key,
  trigger_type, trigger_amount, reward_asd, reward_note, delivery_status,
  delivery_completed_at
)
select distinct on (log.guild_id, log.user_id, log.new_level_key)
  'qiunai', log.guild_id, log.user_id, log.new_level_key,
  log.old_level_key, log.trigger_type, coalesce(log.trigger_amount, 0),
  coalesce(log.reward_asd, 0), log.reward_note, 'completed', now()
from public.vip_upgrade_logs log
left join public.vip_levels level on level.level_key = log.new_level_key
  and level.guild_id = '1206138511535898654'
-- shared vip_upgrade_logs 的 NULL guild 舊資料無法可靠判定店別，禁止用
-- level_key 反推為秋奈；user_vips 的嚴格 guild 回填已覆蓋現有會員。
where log.guild_id = '1206138511535898654'
  and log.user_id is not null and log.new_level_key is not null
order by log.guild_id, log.user_id, log.new_level_key,
  log.created_at desc
on conflict (organization_code, guild_id, user_id, level_key) do nothing;

create table if not exists public.bot_manual_topups (
  organization_code text not null,
  topup_no text not null,
  user_id text not null,
  amount numeric not null check (amount > 0),
  confirmed_by text,
  status text not null default 'completed',
  final_balance numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_code, topup_no),
  check (status in ('processing', 'completed', 'failed'))
);
alter table public.bot_manual_topups enable row level security;
revoke all on public.bot_manual_topups from public, anon, authenticated;
grant all on public.bot_manual_topups to service_role;

-- 若曾在預備環境套過無 guild scope 的草稿，先移除舊 overload，避免
-- service_role 誤呼叫未分租戶版本；正式版本下方會逐一 revoke PUBLIC。
drop function if exists public.qiunai_claim_order_dispatch(text);
drop function if exists public.qiunai_checkpoint_order_dispatch(text,text,text,integer);
drop function if exists public.qiunai_complete_order_dispatch(text,integer);
drop function if exists public.qiunai_fail_order_dispatch(text,text,integer);

create or replace function public.qiunai_claim_order_dispatch(
  p_order_id text, p_guild_id text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item public.play_orders%rowtype;
begin
  if p_guild_id is distinct from '1206138511535898654' then
    raise exception '派單 guild_id 不屬於秋奈';
  end if;
  select * into item from public.play_orders
  where id::text = p_order_id and guild_id = p_guild_id for update;
  if not found then raise exception '找不到派單訂單'; end if;
  if not coalesce(item.paid, false) then raise exception '訂單尚未付款，不能派單'; end if;

  if item.dispatch_status = 'dispatched' then
    return jsonb_build_object(
      'claimed', false, 'state', 'dispatched', 'order', to_jsonb(item),
      'attempt', item.dispatch_attempts,
      'staff_message_id', item.dispatch_message_id,
      'control_message_id', item.dispatch_control_message_id
    );
  end if;
  if item.dispatch_status = 'processing'
     and item.dispatch_claimed_at > now() - interval '2 minutes' then
    return jsonb_build_object(
      'claimed', false, 'state', 'processing', 'order', to_jsonb(item),
      'attempt', item.dispatch_attempts,
      'staff_message_id', item.dispatch_message_id,
      'control_message_id', item.dispatch_control_message_id
    );
  end if;
  if item.dispatch_status = 'not_ready'
     and not (item.quote_status = 'dispatched' or item.status = 'pending') then
    raise exception '訂單尚未進入派單階段';
  end if;

  update public.play_orders set
    dispatch_status = 'processing',
    dispatch_attempts = coalesce(dispatch_attempts, 0) + 1,
    dispatch_claimed_at = now(),
    dispatch_last_error = null,
    updated_at = now()
  where id = item.id and guild_id = p_guild_id returning * into item;
  return jsonb_build_object(
    'claimed', true, 'state', 'processing', 'order', to_jsonb(item),
    'attempt', item.dispatch_attempts,
    'staff_message_id', item.dispatch_message_id,
    'control_message_id', item.dispatch_control_message_id
  );
end;
$$;

create or replace function public.qiunai_checkpoint_order_dispatch(
  p_order_id text, p_guild_id text, p_stage text, p_message_id text, p_attempt integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare item public.play_orders%rowtype;
begin
  if p_stage not in ('staff', 'control') or nullif(trim(p_message_id), '') is null
     or coalesce(p_attempt, 0) <= 0 then
    raise exception '派單 checkpoint 參數錯誤';
  end if;
  update public.play_orders set
    dispatch_message_id = case when p_stage = 'staff' then p_message_id else dispatch_message_id end,
    dispatch_control_message_id = case when p_stage = 'control' then p_message_id else dispatch_control_message_id end,
    updated_at = now()
  where id::text = p_order_id and guild_id = p_guild_id
    and p_guild_id = '1206138511535898654' and dispatch_status = 'processing'
    and dispatch_attempts = p_attempt
  returning * into item;
  if not found then raise exception '派單未被目前流程鎖定'; end if;
  return to_jsonb(item);
end;
$$;

create or replace function public.qiunai_complete_order_dispatch(
  p_order_id text, p_guild_id text, p_attempt integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item public.play_orders%rowtype;
begin
  update public.play_orders set
    dispatch_status = 'dispatched', dispatched_at = coalesce(dispatched_at, now()),
    dispatch_claimed_at = null, dispatch_last_error = null, quote_status = 'dispatched',
    updated_at = now()
  where id::text = p_order_id and guild_id = p_guild_id
    and p_guild_id = '1206138511535898654' and dispatch_status = 'processing'
    and dispatch_attempts = p_attempt
    and dispatch_message_id is not null and dispatch_control_message_id is not null
  returning * into item;
  if not found then raise exception '派單訊息尚未完整保存'; end if;
  return to_jsonb(item);
end;
$$;

create or replace function public.qiunai_fail_order_dispatch(
  p_order_id text, p_guild_id text, p_error text, p_attempt integer
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.play_orders set
    dispatch_status = 'failed', dispatch_claimed_at = null,
    dispatch_last_error = left(coalesce(p_error, 'unknown'), 1500), updated_at = now()
  where id::text = p_order_id and guild_id = p_guild_id
    and p_guild_id = '1206138511535898654' and dispatch_status = 'processing'
    and dispatch_attempts = p_attempt;
end;
$$;

-- 單張客服單的 ASD／月結付款必須在同一筆 transaction
-- 就寫入 pending，不能在付款 RPC 返回後再由 Node 補寫。
create or replace function public.qiunai_pay_service_order_with_wallet(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  receipt jsonb;
  paid_order public.play_orders%rowtype;
begin
  select to_jsonb(public.pay_play_order_with_wallet(p_order_id)) into receipt;
  update public.play_orders set
    status = 'pending', quote_status = 'dispatched', dispatch_status = 'pending',
    dispatch_last_error = null, updated_at = now()
  where id = p_order_id and coalesce(paid, false)
  returning * into paid_order;
  if not found then raise exception '付款完成，但無法建立待派單狀態'; end if;
  return coalesce(receipt, '{}'::jsonb) || jsonb_build_object('order', to_jsonb(paid_order));
end;
$$;

create or replace function public.qiunai_pay_service_order_with_monthly(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  receipt jsonb;
  paid_order public.play_orders%rowtype;
begin
  select to_jsonb(public.pay_play_order_with_monthly(p_order_id)) into receipt;
  update public.play_orders set
    status = 'pending', quote_status = 'dispatched', dispatch_status = 'pending',
    dispatch_last_error = null, updated_at = now()
  where id = p_order_id and coalesce(paid, false)
  returning * into paid_order;
  if not found then raise exception '付款完成，但無法建立待派單狀態'; end if;
  return coalesce(receipt, '{}'::jsonb) || jsonb_build_object('order', to_jsonb(paid_order));
end;
$$;

create or replace function public.qiunai_apply_manual_topup(
  p_topup_no text, p_user_id text, p_amount numeric, p_confirmed_by text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  existing public.bot_manual_topups%rowtype;
  balance_value numeric;
  normalized_no text := trim(coalesce(p_topup_no, ''));
  effect_key text;
  result_value jsonb;
begin
  if normalized_no = '' or trim(coalesce(p_user_id, '')) = '' or p_amount <= 0 then
    raise exception '儲值資料錯誤';
  end if;
  insert into public.bot_manual_topups(
    organization_code, topup_no, user_id, amount, confirmed_by, status
  ) values ('qiunai', normalized_no, p_user_id, p_amount, p_confirmed_by, 'processing')
  on conflict (organization_code, topup_no) do nothing;

  select * into existing from public.bot_manual_topups
  where organization_code = 'qiunai' and topup_no = normalized_no for update;
  if existing.user_id is distinct from p_user_id or existing.amount is distinct from p_amount then
    raise exception '同一儲值編號的會員或金額不一致';
  end if;
  if existing.status = 'completed' then
    result_value := jsonb_build_object(
      'already_processed', true, 'amount', existing.amount,
      'balance', existing.final_balance, 'topup_no', existing.topup_no,
      'user_id', existing.user_id
    );
    effect_key := 'manual-topup-effects:' || normalized_no;
    insert into public.bot_financial_operations(
      organization_code, operation_key, operation_type, entity_id, actor_id, amount, result
    ) values ('qiunai', effect_key, 'manual_topup_effects', normalized_no,
      coalesce(existing.confirmed_by, p_confirmed_by), existing.amount, result_value)
    on conflict (organization_code, operation_key) do nothing;
    return result_value || jsonb_build_object('effects_key', effect_key);
  end if;

  insert into public.users(user_id, coins) values (p_user_id, 0)
  on conflict (user_id) do nothing;
  select coalesce(coins, 0) into balance_value from public.users
  where user_id = p_user_id for update;
  balance_value := balance_value + p_amount;
  update public.users set coins = balance_value where user_id = p_user_id;
  insert into public.wallet_logs(user_id, type, amount, balance, note)
  values (p_user_id, '儲值', p_amount, balance_value,
    '💳 自動儲值成功｜' || normalized_no);
  update public.bot_manual_topups set
    status = 'completed', final_balance = balance_value, updated_at = now()
  where organization_code = 'qiunai' and topup_no = normalized_no;
  result_value := jsonb_build_object(
    'already_processed', false, 'amount', p_amount,
    'balance', balance_value, 'topup_no', normalized_no, 'user_id', p_user_id
  );
  effect_key := 'manual-topup-effects:' || normalized_no;
  insert into public.bot_financial_operations(
    organization_code, operation_key, operation_type, entity_id, actor_id, amount, result
  ) values ('qiunai', effect_key, 'manual_topup_effects', normalized_no,
    p_confirmed_by, p_amount, result_value)
  on conflict (organization_code, operation_key) do nothing;
  return result_value || jsonb_build_object('effects_key', effect_key);
end;
$$;

create or replace function public.qiunai_claim_financial_effect(p_operation_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare item public.bot_financial_operations%rowtype;
begin
  select * into item from public.bot_financial_operations
  where organization_code = 'qiunai' and operation_key = p_operation_key for update;
  if not found then raise exception '找不到待補償財務效果'; end if;
  if item.effects_status = 'completed' then
    return jsonb_build_object('claimed', false, 'state', 'completed', 'operation', to_jsonb(item));
  end if;
  if item.effects_status = 'processing'
     and item.effects_claimed_at > now() - interval '2 minutes' then
    return jsonb_build_object('claimed', false, 'state', 'processing', 'operation', to_jsonb(item));
  end if;
  update public.bot_financial_operations set
    effects_status = 'processing', effects_attempts = effects_attempts + 1,
    effects_claimed_at = now(), effects_last_error = null, updated_at = now()
  where organization_code = 'qiunai' and operation_key = p_operation_key
  returning * into item;
  return jsonb_build_object(
    'claimed', true, 'state', 'processing', 'attempt', item.effects_attempts,
    'operation', to_jsonb(item)
  );
end;
$$;

create or replace function public.qiunai_complete_financial_effect(
  p_operation_key text, p_attempt integer
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bot_financial_operations set
    effects_status = 'completed', effects_completed_at = coalesce(effects_completed_at, now()),
    effects_claimed_at = null, effects_last_error = null, updated_at = now()
  where organization_code = 'qiunai' and operation_key = p_operation_key
    and effects_status = 'processing' and effects_attempts = p_attempt;
  if not found then raise exception '財務效果完成標記已過期'; end if;
end;
$$;

create or replace function public.qiunai_fail_financial_effect(
  p_operation_key text, p_attempt integer, p_error text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bot_financial_operations set
    effects_status = 'failed', effects_claimed_at = null,
    effects_last_error = left(coalesce(p_error, 'unknown'), 1500), updated_at = now()
  where organization_code = 'qiunai' and operation_key = p_operation_key
    and effects_status = 'processing' and effects_attempts = p_attempt;
end;
$$;

create or replace function public.qiunai_apply_vip_effect(
  p_operation_key text,
  p_user_id text,
  p_guild_id text,
  p_trigger_type text,
  p_amount numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  existing_effect public.bot_vip_effects%rowtype;
  vip_row public.user_vips%rowtype;
  normalized_key text := trim(coalesce(p_operation_key, ''));
  normalized_user text := trim(coalesce(p_user_id, ''));
  normalized_guild text := trim(coalesce(p_guild_id, ''));
  amount_value integer;
  inserted_count integer := 0;
begin
  if normalized_key = '' or normalized_user = '' or normalized_guild = '' then
    raise exception 'VIP 累積補償資料不完整';
  end if;
  if normalized_guild <> '1206138511535898654' then
    raise exception 'VIP 累積補償 guild_id 不屬於秋奈';
  end if;
  if p_trigger_type not in ('topup', 'spend') then
    raise exception 'VIP 累積類型錯誤';
  end if;
  if p_amount is null or p_amount <> trunc(p_amount) then
    raise exception 'VIP 累積金額必須是整數';
  end if;
  amount_value := p_amount::integer;
  if p_trigger_type = 'topup' and amount_value <= 0 then
    raise exception '儲值 VIP 累積金額必須大於 0';
  end if;

  -- 先建立並鎖住店別 + 使用者的 VIP 列，再以 operation_key 寫入唯一效果。
  -- 更新總額與寫入效果在同一 transaction，任何一邊失敗都會一起 rollback。
  insert into public.user_vips(user_id, guild_id)
  values (normalized_user, normalized_guild)
  on conflict (guild_id, user_id) do nothing;
  select * into vip_row from public.user_vips
  where guild_id = normalized_guild and user_id = normalized_user for update;
  if not found then raise exception '無法建立 VIP 累積資料'; end if;

  insert into public.bot_vip_effects(
    organization_code, operation_key, guild_id, user_id, trigger_type, amount
  ) values (
    'qiunai', normalized_key, normalized_guild, normalized_user,
    p_trigger_type, amount_value
  ) on conflict (organization_code, operation_key) do nothing;
  get diagnostics inserted_count = row_count;

  select * into existing_effect from public.bot_vip_effects
  where organization_code = 'qiunai' and operation_key = normalized_key for update;
  if existing_effect.guild_id is distinct from normalized_guild
     or existing_effect.user_id is distinct from normalized_user
     or existing_effect.trigger_type is distinct from p_trigger_type
     or existing_effect.amount is distinct from amount_value then
    raise exception '同一 VIP 補償編號的店別、會員、類型或金額不一致';
  end if;

  if inserted_count > 0 then
    update public.user_vips set
      total_topup = case when p_trigger_type = 'topup'
        then greatest(0, coalesce(total_topup, 0) + amount_value)
        else total_topup end,
      highest_single_topup = case when p_trigger_type = 'topup'
        then greatest(coalesce(highest_single_topup, 0), amount_value)
        else highest_single_topup end,
      total_spent = case when p_trigger_type = 'spend'
        then greatest(0, coalesce(total_spent, 0) + amount_value)
        else total_spent end,
      updated_at = now()
    where id = vip_row.id
    returning * into vip_row;
  else
    select * into vip_row from public.user_vips
    where guild_id = normalized_guild and user_id = normalized_user for update;
  end if;

  return jsonb_build_object(
    'already_applied', inserted_count = 0,
    'total_spent', vip_row.total_spent,
    'total_topup', vip_row.total_topup,
    'highest_single_topup', vip_row.highest_single_topup
  );
end;
$$;

create or replace function public.qiunai_promote_vip_level(
  p_guild_id text, p_user_id text, p_level_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  vip_row public.user_vips%rowtype;
  requested_level public.vip_levels%rowtype;
  previous_sort integer := 0;
  requested_sort integer := 0;
  actual_sort integer := 0;
  previous_level_key text;
  promoted boolean := false;
begin
  if p_guild_id is distinct from '1206138511535898654' then
    raise exception 'VIP 等級更新 guild_id 不屬於秋奈';
  end if;
  select * into requested_level from public.vip_levels
  where guild_id = p_guild_id and level_key = p_level_key;
  if not found then raise exception '找不到 VIP 等級設定'; end if;
  requested_sort := coalesce(requested_level.sort_order, 0);

  select * into vip_row from public.user_vips
  where guild_id = p_guild_id and user_id = p_user_id for update;
  if not found then raise exception '找不到 VIP 累積資料'; end if;
  previous_level_key := vip_row.level_key;
  select coalesce(sort_order, 0) into previous_sort from public.vip_levels
  where guild_id = p_guild_id and level_key = vip_row.level_key;
  if not found then previous_sort := 0; end if;

  if requested_sort > previous_sort then
    update public.user_vips set
      level_key = requested_level.level_key,
      level_name = requested_level.level_name,
      updated_at = now()
    where id = vip_row.id returning * into vip_row;
    actual_sort := requested_sort;
    promoted := true;
  else
    actual_sort := previous_sort;
  end if;
  return jsonb_build_object(
    'promoted', promoted,
    'previous_level_key', previous_level_key,
    'previous_sort_order', previous_sort,
    'level_key', vip_row.level_key,
    'level_name', vip_row.level_name,
    'sort_order', actual_sort,
    'vip', to_jsonb(vip_row)
  );
end;
$$;

create or replace function public.qiunai_apply_vip_level_reward(
  p_guild_id text,
  p_user_id text,
  p_level_key text,
  p_old_level_key text,
  p_trigger_type text,
  p_trigger_amount numeric,
  p_reward_coupons jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  operation_row public.bot_vip_reward_operations%rowtype;
  level_row public.vip_levels%rowtype;
  coupon jsonb;
  coupon_name text;
  coupon_count integer;
  final_balance_value integer;
  normalized_guild text := trim(coalesce(p_guild_id, ''));
  normalized_user text := trim(coalesce(p_user_id, ''));
  normalized_level text := trim(coalesce(p_level_key, ''));
begin
  if normalized_guild = '' or normalized_user = '' or normalized_level = '' then
    raise exception 'VIP 升等獎勵資料不完整';
  end if;
  if normalized_guild <> '1206138511535898654' then
    raise exception 'VIP 升等獎勵 guild_id 不屬於秋奈';
  end if;
  if p_trigger_type not in ('topup', 'spend') then
    raise exception 'VIP 升等獎勵觸發類型錯誤';
  end if;
  if jsonb_typeof(coalesce(p_reward_coupons, '[]'::jsonb)) <> 'array' then
    raise exception 'VIP 優惠券獎勵格式錯誤';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'qiunai-vip-reward:' || normalized_guild || ':' || normalized_user || ':' || normalized_level,
    0
  ));

  select * into operation_row from public.bot_vip_reward_operations
  where organization_code = 'qiunai' and guild_id = normalized_guild
    and user_id = normalized_user and level_key = normalized_level for update;
  if found then
    return to_jsonb(operation_row) || jsonb_build_object('already_applied', true);
  end if;

  select * into level_row from public.vip_levels
  where guild_id = normalized_guild and level_key = normalized_level for update;
  if not found then raise exception '找不到 VIP 等級獎勵設定'; end if;

  insert into public.users(user_id, coins) values (normalized_user, 0)
  on conflict (user_id) do nothing;
  select coalesce(coins, 0) into final_balance_value from public.users
  where user_id = normalized_user for update;
  if coalesce(level_row.reward_asd, 0) > 0 then
    update public.users set coins = coalesce(coins, 0) + level_row.reward_asd
    where user_id = normalized_user returning coins into final_balance_value;
    insert into public.wallet_logs(user_id, type, amount, balance, note)
    values (
      normalized_user, 'VIP升級獎勵', level_row.reward_asd, final_balance_value,
      '升級 ' || level_row.level_name || '｜獲得 ' || level_row.reward_asd::text || ' ASD'
    );
  end if;

  for coupon in select value from jsonb_array_elements(coalesce(p_reward_coupons, '[]'::jsonb))
  loop
    coupon_name := trim(coalesce(coupon->>'name', ''));
    coupon_count := coalesce((coupon->>'count')::integer, 0);
    if coupon_name = '' or coupon_count <= 0 or coupon_count > 100 then
      raise exception 'VIP 優惠券獎勵內容錯誤';
    end if;
    insert into public.user_items(
      user_id, item_name, rarity, description, item_type, guild_id
    )
    select normalized_user, coupon_name, 'VIP',
      level_row.level_name || ' 升級獎勵', 'coupon', normalized_guild
    from generate_series(1, coupon_count);
  end loop;

  insert into public.vip_upgrade_logs(
    guild_id, user_id, old_level_key, new_level_key, trigger_type,
    trigger_amount, reward_asd, reward_coupon, reward_note
  ) values (
    normalized_guild, normalized_user, p_old_level_key, normalized_level,
    p_trigger_type, coalesce(p_trigger_amount, 0)::integer,
    coalesce(level_row.reward_asd, 0), level_row.reward_coupon, level_row.reward_note
  );

  insert into public.bot_vip_reward_operations(
    organization_code, guild_id, user_id, level_key, old_level_key,
    trigger_type, trigger_amount, reward_asd, reward_coupons, reward_note,
    role_id, level_name, final_balance, delivery_status
  ) values (
    'qiunai', normalized_guild, normalized_user, normalized_level, p_old_level_key,
    p_trigger_type, coalesce(p_trigger_amount, 0)::integer,
    coalesce(level_row.reward_asd, 0), coalesce(p_reward_coupons, '[]'::jsonb),
    level_row.reward_note, level_row.role_id, level_row.level_name,
    final_balance_value, 'pending'
  ) returning * into operation_row;
  return to_jsonb(operation_row) || jsonb_build_object('already_applied', false);
end;
$$;

create or replace function public.qiunai_claim_vip_reward_delivery(
  p_guild_id text, p_user_id text, p_level_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare operation_row public.bot_vip_reward_operations%rowtype;
begin
  if p_guild_id is distinct from '1206138511535898654' then
    raise exception 'VIP 獎勵派送 guild_id 不屬於秋奈';
  end if;
  select * into operation_row from public.bot_vip_reward_operations
  where organization_code = 'qiunai' and guild_id = p_guild_id
    and user_id = p_user_id and level_key = p_level_key for update;
  if not found then raise exception '找不到 VIP 獎勵派送資料'; end if;
  if operation_row.delivery_status = 'completed' then
    return jsonb_build_object(
      'claimed', false, 'state', 'completed', 'operation', to_jsonb(operation_row)
    );
  end if;
  if operation_row.delivery_status = 'processing'
     and operation_row.delivery_claimed_at > now() - interval '2 minutes' then
    return jsonb_build_object(
      'claimed', false, 'state', 'processing', 'operation', to_jsonb(operation_row)
    );
  end if;
  update public.bot_vip_reward_operations set
    delivery_status = 'processing', delivery_attempts = delivery_attempts + 1,
    delivery_claimed_at = now(), delivery_last_error = null, updated_at = now()
  where organization_code = 'qiunai' and guild_id = p_guild_id
    and user_id = p_user_id and level_key = p_level_key
  returning * into operation_row;
  return jsonb_build_object(
    'claimed', true, 'state', 'processing',
    'attempt', operation_row.delivery_attempts, 'operation', to_jsonb(operation_row)
  );
end;
$$;

create or replace function public.qiunai_complete_vip_reward_delivery(
  p_guild_id text, p_user_id text, p_level_key text, p_attempt integer
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_guild_id is distinct from '1206138511535898654' then
    raise exception 'VIP 獎勵派送 guild_id 不屬於秋奈';
  end if;
  update public.bot_vip_reward_operations set
    delivery_status = 'completed',
    delivery_completed_at = coalesce(delivery_completed_at, now()),
    delivery_claimed_at = null, delivery_last_error = null, updated_at = now()
  where organization_code = 'qiunai' and guild_id = p_guild_id
    and user_id = p_user_id and level_key = p_level_key
    and delivery_status = 'processing' and delivery_attempts = p_attempt;
  if not found then raise exception 'VIP 獎勵派送完成標記已過期'; end if;
end;
$$;

create or replace function public.qiunai_fail_vip_reward_delivery(
  p_guild_id text, p_user_id text, p_level_key text,
  p_attempt integer, p_error text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_guild_id is distinct from '1206138511535898654' then
    raise exception 'VIP 獎勵派送 guild_id 不屬於秋奈';
  end if;
  update public.bot_vip_reward_operations set
    delivery_status = 'failed', delivery_claimed_at = null,
    delivery_last_error = left(coalesce(p_error, 'unknown'), 1500), updated_at = now()
  where organization_code = 'qiunai' and guild_id = p_guild_id
    and user_id = p_user_id and level_key = p_level_key
    and delivery_status = 'processing' and delivery_attempts = p_attempt;
end;
$$;

create or replace function public.qiunai_apply_salary_order_payment(
  p_operation_key text,
  p_customer_id text,
  p_amount numeric,
  p_order_ids uuid[],
  p_guild_id text,
  p_payment_method text,
  p_final_status text,
  p_quote_status text,
  p_wallet_start timestamptz,
  p_advance_limit numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  operation_row public.bot_financial_operations%rowtype;
  order_row public.play_orders%rowtype;
  normalized_key text := trim(coalesce(p_operation_key, ''));
  normalized_customer text := trim(coalesce(p_customer_id, ''));
  normalized_guild text := trim(coalesce(p_guild_id, ''));
  amount_value integer;
  locked_ids uuid[] := '{}';
  adjustment_id uuid;
  staff_name_value text;
  wallet_deposited numeric := 0;
  reserved_withdrawals numeric := 0;
  pending_salary numeric := 0;
  pending_adjustments numeric := 0;
  available_before numeric := 0;
  projected_advance numeric := 0;
  result_orders jsonb;
  result_value jsonb;
begin
  if normalized_key = '' or normalized_customer = '' or normalized_guild = ''
     or coalesce(cardinality(p_order_ids), 0) = 0 then
    raise exception '扣薪付款資料不完整';
  end if;
  if normalized_guild <> '1206138511535898654' then
    raise exception '扣薪付款 guild_id 不屬於秋奈';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then
    raise exception '扣薪付款金額錯誤';
  end if;
  if p_final_status not in ('waiting_confirm', 'pending')
     or (p_quote_status is not null and p_quote_status <> 'dispatched') then
    raise exception '扣薪付款訂單狀態錯誤';
  end if;
  if p_payment_method not in ('扣薪', '扣薪＋轉帳') then
    raise exception '扣薪付款方式錯誤';
  end if;
  amount_value := p_amount::integer;

  -- 同一操作鍵與同一員工的付款都以 transaction advisory lock 串行化。
  perform pg_advisory_xact_lock(hashtextextended('qiunai-salary-op:' || normalized_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('qiunai-salary-user:' || normalized_customer, 0));

  select * into operation_row from public.bot_financial_operations
  where organization_code = 'qiunai' and operation_key = normalized_key for update;
  if found then
    if operation_row.operation_type <> 'salary_deduction_payment'
       or operation_row.actor_id is distinct from normalized_customer
       or operation_row.amount is distinct from amount_value then
      raise exception '同一扣薪付款編號的員工或金額不一致';
    end if;
    return operation_row.result || jsonb_build_object('already_processed', true);
  end if;

  select coalesce(display_name, real_name, discord_name, discord_username, discord_id)
  into staff_name_value
  from public.qiunai_staff
  where discord_id = normalized_customer and coalesce(is_active, true)
    and (guild_id = normalized_guild or guild_id is null)
  order by (guild_id = normalized_guild) desc
  limit 1;
  if not found then raise exception '扣薪付款僅限秋奈在職員工使用'; end if;

  for order_row in
    select * from public.play_orders
    where id = any(p_order_ids) order by id for update
  loop
    if order_row.guild_id is distinct from normalized_guild
       or order_row.customer_id is distinct from normalized_customer
       or coalesce(order_row.paid, false)
       or coalesce(order_row.is_deleted, false) then
      raise exception '訂單已付款、已結束或不屬於秋奈店別';
    end if;
    locked_ids := array_append(locked_ids, order_row.id);
  end loop;
  if cardinality(locked_ids) <> cardinality(p_order_ids)
     or cardinality(locked_ids) <> (
       select count(distinct input_id)::integer from unnest(p_order_ids) input_id
     ) then
    raise exception '扣薪付款訂單資料不完整或重複';
  end if;

  -- 在持有員工 advisory lock 後重新計算可用薪資，避免兩次按鈕同時通過
  -- Node 端的舊快照。此計算與新增扣項、標記訂單付款在同一 transaction。
  select coalesce(sum(amount), 0) into wallet_deposited
  from public.salary_wallet_entries
  where app_key = 'qiunai' and discord_id = normalized_customer;
  select coalesce(sum(amount), 0) into reserved_withdrawals
  from public.salary_withdraw_requests
  where app_key = 'qiunai' and discord_id = normalized_customer
    and status in ('pending', 'approved');
  select coalesce(sum(coalesce(staff_salary, 0) + coalesce(bonus_amount, 0)), 0)
  into pending_salary
  from public.qiunai_salary_orders
  where discord_id = normalized_customer
    and order_finished_at >= p_wallet_start
    and wallet_settled_at is null
    and coalesce(is_deleted, false) = false
    and coalesce(status, '') <> '已入帳';
  select coalesce(sum(amount), 0) into pending_adjustments
  from public.qiunai_staff_bonus
  where discord_id = normalized_customer
    and created_at >= p_wallet_start
    and wallet_settled_at is null;
  available_before := wallet_deposited - reserved_withdrawals
    + pending_salary + pending_adjustments;
  projected_advance := greatest(0, -(available_before - amount_value));
  if projected_advance > greatest(0, coalesce(p_advance_limit, 0)) then
    raise exception '扣薪付款會超過預支上限';
  end if;

  insert into public.qiunai_staff_bonus(
    discord_id, staff_name, title, amount, note, created_at
  ) values (
    normalized_customer, staff_name_value, '薪水扣除', -amount_value,
    '使用薪水點單', now()
  ) returning id into adjustment_id;

  update public.play_orders set
    payment_method = p_payment_method,
    paid = true,
    paid_at = coalesce(paid_at, now()),
    status = p_final_status,
    quote_status = coalesce(p_quote_status, quote_status),
    dispatch_status = case
      when p_quote_status = 'dispatched' and p_final_status = 'pending'
      then 'pending' else dispatch_status end,
    dispatch_last_error = case
      when p_quote_status = 'dispatched' and p_final_status = 'pending'
      then null else dispatch_last_error end,
    updated_at = now()
  where id = any(locked_ids);

  select jsonb_agg(to_jsonb(item) order by item.id) into result_orders
  from public.play_orders item where item.id = any(locked_ids);
  result_value := jsonb_build_object(
    'already_processed', false,
    'adjustment_id', adjustment_id,
    'orders', coalesce(result_orders, '[]'::jsonb),
    'available_before', available_before,
    'projected_advance', projected_advance
  );
  insert into public.bot_financial_operations(
    organization_code, operation_key, operation_type, entity_id, actor_id,
    amount, status, result, effects_status, effects_completed_at
  ) values (
    'qiunai', normalized_key, 'salary_deduction_payment',
    array_to_string(locked_ids, ','), normalized_customer,
    amount_value, 'completed', result_value, 'completed', now()
  );
  return result_value;
end;
$$;

create or replace function public.qiunai_pay_extension_with_wallet(
  p_extension_id text, p_customer_id text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  extension_row public.order_extensions%rowtype;
  order_row public.play_orders%rowtype;
  amount_value numeric;
  final_balance numeric;
  old_price numeric;
  new_price numeric;
  already_paid boolean := false;
  repaired_application boolean := false;
begin
  select * into extension_row from public.order_extensions
  where id::text = p_extension_id for update;
  if not found then raise exception '找不到加時資料'; end if;
  if extension_row.customer_id is distinct from p_customer_id then
    raise exception '只有原下單者可以付款';
  end if;
  if coalesce(extension_row.paid, false) then
    if coalesce(extension_row.payment_method, '') not in ('儲值卡', '儲值卡 / 錢包') then
      raise exception '這筆加時已使用其他方式付款';
    end if;
    already_paid := true;
  end if;
  if extension_row.status = 'cancelled' then raise exception '這筆加時已取消'; end if;
  amount_value := coalesce(extension_row.amount, 0);
  if amount_value <= 0 then raise exception '加時金額錯誤'; end if;

  select * into order_row from public.play_orders
  where id::text = extension_row.order_id::text for update;
  if not found then raise exception '找不到加時原訂單'; end if;

  old_price := coalesce(order_row.final_price, order_row.price, 0);
  new_price := old_price;

  if not already_paid then
    select coalesce(coins, 0) into final_balance from public.users
    where user_id = p_customer_id for update;
    if not found or final_balance < amount_value then raise exception 'ASD 餘額不足'; end if;
    final_balance := final_balance - amount_value;
    update public.users set coins = final_balance where user_id = p_customer_id;
    insert into public.wallet_logs(user_id, type, amount, balance, note)
    values (p_customer_id, '加時扣款', -amount_value, final_balance,
      '加時 ' || coalesce(extension_row.extension_text, '') || '｜原訂單 ' ||
      coalesce(extension_row.order_no, extension_row.order_id::text));
  else
    select coalesce(coins, 0) into final_balance from public.users
    where user_id = p_customer_id;
  end if;

  -- 舊版可能已扣 ASD，卻在原單加價前中斷。此時只補應用，不再扣款。
  if not coalesce(extension_row.applied_to_salary, false) then
    new_price := old_price + amount_value;
    update public.play_orders set
      price = new_price,
      final_price = new_price,
      service = coalesce(order_row.service, order_row.order_item, '陪玩訂單') ||
        '｜加時：' || coalesce(extension_row.extension_text, '加時'),
      note = trim(coalesce(order_row.note, '') || E'\n[加時] ' ||
        coalesce(extension_row.extension_text, '加時') || '｜+NT$' || amount_value::text),
      updated_at = now()
    where id = order_row.id returning * into order_row;
    repaired_application := already_paid;
  end if;

  update public.order_extensions set
    payment_method = '儲值卡', paid = true, status = 'paid',
    paid_at = coalesce(paid_at, now()), applied_to_salary = true,
    applied_at = coalesce(applied_at, now()), updated_at = now()
  where id = extension_row.id returning * into extension_row;
  return jsonb_build_object(
    'already_processed', already_paid, 'repaired_application', repaired_application,
    'amount', amount_value, 'balance', final_balance,
    'old_price', old_price, 'new_price', new_price,
    'extension', to_jsonb(extension_row), 'order', to_jsonb(order_row)
  );
end;
$$;

create or replace function public.qiunai_cancel_self_service_order(
  p_order_id text,
  p_customer_id text,
  p_expected_quote_status text[],
  p_final_quote_status text,
  p_operation_key text,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  order_row public.play_orders%rowtype;
  old_vip_counted boolean;
  refund_amount numeric := 0;
  final_balance numeric;
  result_value jsonb;
begin
  if p_final_quote_status not in ('cancelled', 'self_dispatch_failed') then
    raise exception '取消訂單狀態錯誤';
  end if;
  select * into order_row from public.play_orders where id::text = p_order_id for update;
  if not found then raise exception '找不到自助訂單'; end if;
  if order_row.customer_id is distinct from p_customer_id then raise exception '只有原下單者可以取消'; end if;

  select result into result_value from public.bot_financial_operations
  where organization_code = 'qiunai' and operation_key = p_operation_key;
  if found then return result_value || jsonb_build_object('already_processed', true); end if;
  if order_row.quote_status = p_final_quote_status and order_row.status = 'cancelled' then
    return jsonb_build_object('already_processed', true, 'refund_amount', 0, 'order', to_jsonb(order_row));
  end if;
  if not (order_row.quote_status = any(p_expected_quote_status)) then
    raise exception '訂單已不在可取消階段';
  end if;

  old_vip_counted := coalesce(order_row.vip_spent_counted, false);
  if coalesce(order_row.paid, false) then
    if not (
      coalesce(order_row.payment_method, '') like '%儲值卡%' or
      coalesce(order_row.payment_method, '') like '%錢包%' or
      coalesce(order_row.payment_method, '') like '%ASD%'
    ) then raise exception '這張訂單不是 ASD 付款，請聯繫客服人工退款'; end if;
    refund_amount := coalesce(order_row.final_price, order_row.price, 0);
    if refund_amount <= 0 then raise exception '訂單退款金額不正確'; end if;
    select coalesce(coins, 0) into final_balance from public.users
      where user_id = p_customer_id for update;
    if not found then raise exception '找不到會員錢包'; end if;
    final_balance := final_balance + refund_amount;
    update public.users set coins = final_balance where user_id = p_customer_id;
    insert into public.wallet_logs(user_id, type, amount, balance, note)
    values (p_customer_id, '訂單退款', refund_amount, final_balance,
      '自助訂單 ' || coalesce(order_row.order_no, order_row.id::text) || '｜' || p_reason);
  end if;

  update public.play_orders set
    status = 'cancelled', quote_status = p_final_quote_status,
    preferred_player = null, assigned_player = null,
    paid = case when refund_amount > 0 then false else paid end,
    payment_method = case when refund_amount > 0 then 'ASD 已退款' else payment_method end,
    vip_spent_counted = case when refund_amount > 0 then false else vip_spent_counted end,
    vip_spent_counted_at = case when refund_amount > 0 then null else vip_spent_counted_at end,
    updated_at = now()
  where id = order_row.id returning * into order_row;
  result_value := jsonb_build_object(
    'already_processed', false, 'refund_amount', refund_amount,
    'balance', final_balance, 'was_vip_spent_counted', old_vip_counted,
    'order', to_jsonb(order_row)
  );
  insert into public.bot_financial_operations(
    organization_code, operation_key, operation_type, entity_id, actor_id, amount, result
  ) values ('qiunai', p_operation_key, 'self_service_refund', p_order_id,
    p_customer_id, refund_amount, result_value);
  return result_value;
end;
$$;

create or replace function public.qiunai_reverse_jkopay_extension(
  p_platform_order_id text, p_requested_by text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  payment_row public.jkopay_service_payments%rowtype;
  extension_row public.order_extensions%rowtype;
  order_row public.play_orders%rowtype;
  extension_id text;
  op_key_value text := 'jkopay-service-refund:' || p_platform_order_id || ':local';
  old_price numeric;
  new_price numeric;
  result_value jsonb;
begin
  select * into payment_row from public.jkopay_service_payments
  where organization_code = 'qiunai' and platform_order_id = p_platform_order_id for update;
  if not found or payment_row.payment_kind <> 'extension' then
    raise exception '找不到街口加時付款';
  end if;
  if payment_row.status not in ('refund_reversal_pending', 'refunded') then
    raise exception '街口退款尚未成功，不能回沖加時';
  end if;
  select result into result_value from public.bot_financial_operations
  where organization_code = 'qiunai' and operation_key = op_key_value;
  if found then return result_value || jsonb_build_object('already_processed', true); end if;

  extension_id := coalesce(payment_row.metadata->>'extensionId', payment_row.entity_key);
  -- 與 EIP 入帳共用排他表鎖，封住「檢查後才被結算」或新增報單的競態。
  lock table public.qiunai_salary_orders in share row exclusive mode;
  select * into extension_row from public.order_extensions
  where id::text = extension_id for update;
  if not found then raise exception '找不到街口退款對應加時單'; end if;
  perform 1 from public.qiunai_salary_orders
  where order_id like 'WORK-EXT-' || extension_id || '-%' for update;
  if exists (
    select 1 from public.qiunai_salary_orders
    where order_id like 'WORK-EXT-' || extension_id || '-%'
      and (
        wallet_settled_at is not null or paid_at is not null or
        status in ('已入帳', '已發薪', 'paid')
      )
  ) then
    raise exception '加時報單已入帳或發薪，已停止本地回沖';
  end if;
  if coalesce(extension_row.applied_to_salary, false) then
    select * into order_row from public.play_orders
    where id::text = extension_row.order_id::text for update;
    if not found then raise exception '找不到街口加時原訂單'; end if;
    old_price := coalesce(order_row.final_price, order_row.price, 0);
    new_price := greatest(0, old_price - coalesce(extension_row.amount, 0));
    update public.play_orders set
      price = new_price, final_price = new_price,
      note = trim(coalesce(order_row.note, '') || E'\n[街口退款] 加時 ' ||
        coalesce(extension_row.extension_text, extension_row.id::text) ||
        '｜-NT$' || coalesce(extension_row.amount, 0)::text),
      updated_at = now()
    where id = order_row.id;
  end if;
  update public.order_extensions set
    paid = false, payment_method = '街口支付（已退款）', status = 'refunded',
    applied_to_salary = false, applied_at = null, updated_at = now()
  where id = extension_row.id returning * into extension_row;
  update public.qiunai_salary_orders set
    is_deleted = true, status = '已退款', deleted_at = now(),
    deleted_reason = '街口退款 ' || p_platform_order_id
  where order_id like 'WORK-EXT-' || extension_id || '-%'
    and coalesce(is_deleted, false) = false;
  result_value := jsonb_build_object(
    'already_processed', false, 'extension_id', extension_id,
    'old_price', old_price, 'new_price', new_price,
    'amount', payment_row.amount
  );
  insert into public.bot_financial_operations(
    organization_code, operation_key, operation_type, entity_id, actor_id, amount, result
  ) values ('qiunai', op_key_value, 'jkopay_extension_reversal', extension_id,
    p_requested_by, payment_row.amount, result_value);
  return result_value;
end;
$$;

-- 覆蓋既有安全函式，讓付款完成後一定留下待派單狀態。
create or replace function public.qiunai_pay_service_group(
 p_group_id text, p_customer_id text, p_guild_id text, p_method text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
 row_order public.play_orders%rowtype;
 ids uuid[] := '{}';
 order_id uuid;
 receipt jsonb;
 total numeric := 0;
 result_orders jsonb;
begin
 if p_method not in ('wallet','monthly') then raise exception 'invalid payment method'; end if;
 for row_order in select * from public.play_orders
   where order_group_id=p_group_id and guild_id=p_guild_id order by id for update
 loop
   if row_order.customer_id is distinct from p_customer_id or coalesce(row_order.paid,false)
     or coalesce(row_order.is_deleted,false) or row_order.status is null
     or row_order.status not in ('waiting_payment','quoted','waiting_confirm') then
     raise exception '訂單已付款或已結束，未重複扣款';
   end if;
   ids := array_append(ids,row_order.id);
 end loop;
 if cardinality(ids) <> 2 then raise exception '分單資料不完整，未扣款'; end if;
 foreach order_id in array ids loop
   if p_method='wallet' then
     select to_jsonb(public.pay_play_order_with_wallet(order_id)) into receipt;
   else
     select to_jsonb(public.pay_play_order_with_monthly(order_id)) into receipt;
   end if;
   total := total + coalesce((receipt->>'amount')::numeric,0);
 end loop;
 update public.play_orders set
   status='pending', quote_status='dispatched', dispatch_status='pending',
   dispatch_last_error=null, updated_at=now()
 where id=any(ids);
 select jsonb_agg(to_jsonb(o) order by o.id) into result_orders
 from public.play_orders o where o.id=any(ids);
 return jsonb_build_object('amount',total,'receipt',receipt,'orders',result_orders);
end;
$$;

create or replace function public.qiunai_transition_unpaid_orders(
  p_guild_id text, p_action text, p_order_id uuid default null, p_group_id text default null
) returns setof public.play_orders language plpgsql security definer set search_path = public as $$
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
    dispatch_status = case when p_action = 'confirm' then 'pending' else dispatch_status end,
    dispatch_last_error = case when p_action = 'confirm' then null else dispatch_last_error end,
    updated_at = now()
    where id = any(ids) returning *;
end;
$$;

revoke all on function public.qiunai_claim_order_dispatch(text,text) from public, anon, authenticated;
revoke all on function public.qiunai_checkpoint_order_dispatch(text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.qiunai_complete_order_dispatch(text,text,integer) from public, anon, authenticated;
revoke all on function public.qiunai_fail_order_dispatch(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.qiunai_pay_service_order_with_wallet(uuid) from public, anon, authenticated;
revoke all on function public.qiunai_pay_service_order_with_monthly(uuid) from public, anon, authenticated;
revoke all on function public.qiunai_apply_manual_topup(text,text,numeric,text) from public, anon, authenticated;
revoke all on function public.qiunai_claim_financial_effect(text) from public, anon, authenticated;
revoke all on function public.qiunai_complete_financial_effect(text,integer) from public, anon, authenticated;
revoke all on function public.qiunai_fail_financial_effect(text,integer,text) from public, anon, authenticated;
revoke all on function public.qiunai_apply_vip_effect(text,text,text,text,numeric) from public, anon, authenticated;
revoke all on function public.qiunai_promote_vip_level(text,text,text) from public, anon, authenticated;
revoke all on function public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb) from public, anon, authenticated;
revoke all on function public.qiunai_claim_vip_reward_delivery(text,text,text) from public, anon, authenticated;
revoke all on function public.qiunai_complete_vip_reward_delivery(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.qiunai_fail_vip_reward_delivery(text,text,text,integer,text) from public, anon, authenticated;
revoke all on function public.qiunai_apply_salary_order_payment(text,text,numeric,uuid[],text,text,text,text,timestamptz,numeric) from public, anon, authenticated;
revoke all on function public.qiunai_pay_extension_with_wallet(text,text) from public, anon, authenticated;
revoke all on function public.qiunai_cancel_self_service_order(text,text,text[],text,text,text) from public, anon, authenticated;
revoke all on function public.qiunai_reverse_jkopay_extension(text,text) from public, anon, authenticated;
revoke all on function public.qiunai_pay_service_group(text,text,text,text) from public, anon, authenticated;
revoke all on function public.qiunai_transition_unpaid_orders(text,text,uuid,text) from public, anon, authenticated;

grant execute on function public.qiunai_claim_order_dispatch(text,text) to service_role;
grant execute on function public.qiunai_checkpoint_order_dispatch(text,text,text,text,integer) to service_role;
grant execute on function public.qiunai_complete_order_dispatch(text,text,integer) to service_role;
grant execute on function public.qiunai_fail_order_dispatch(text,text,text,integer) to service_role;
grant execute on function public.qiunai_pay_service_order_with_wallet(uuid) to service_role;
grant execute on function public.qiunai_pay_service_order_with_monthly(uuid) to service_role;
grant execute on function public.qiunai_apply_manual_topup(text,text,numeric,text) to service_role;
grant execute on function public.qiunai_claim_financial_effect(text) to service_role;
grant execute on function public.qiunai_complete_financial_effect(text,integer) to service_role;
grant execute on function public.qiunai_fail_financial_effect(text,integer,text) to service_role;
grant execute on function public.qiunai_apply_vip_effect(text,text,text,text,numeric) to service_role;
grant execute on function public.qiunai_promote_vip_level(text,text,text) to service_role;
grant execute on function public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb) to service_role;
grant execute on function public.qiunai_claim_vip_reward_delivery(text,text,text) to service_role;
grant execute on function public.qiunai_complete_vip_reward_delivery(text,text,text,integer) to service_role;
grant execute on function public.qiunai_fail_vip_reward_delivery(text,text,text,integer,text) to service_role;
grant execute on function public.qiunai_apply_salary_order_payment(text,text,numeric,uuid[],text,text,text,text,timestamptz,numeric) to service_role;
grant execute on function public.qiunai_pay_extension_with_wallet(text,text) to service_role;
grant execute on function public.qiunai_cancel_self_service_order(text,text,text[],text,text,text) to service_role;
grant execute on function public.qiunai_reverse_jkopay_extension(text,text) to service_role;
grant execute on function public.qiunai_pay_service_group(text,text,text,text) to service_role;
grant execute on function public.qiunai_transition_unpaid_orders(text,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
commit;
