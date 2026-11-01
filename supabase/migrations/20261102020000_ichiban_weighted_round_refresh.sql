-- 一番賞相對權重與分池：保留所有已抽、付款與獎品紀錄。
begin;
select 1 from public.qiunai_ichiban_pool_mutex where id=1 for update;
create table if not exists public.qiunai_ichiban_rounds (
 id integer primary key, started_at timestamptz not null default now(),
 closed_at timestamptz, refresh_remaining integer not null default 50,
 high_tier_weight numeric not null default 0.5 check(high_tier_weight>0),
 last_one_enabled boolean not null default false
);
insert into public.qiunai_ichiban_rounds(id) values(1) on conflict do nothing;
alter table public.qiunai_ichiban_pool_mutex add column if not exists active_round_id integer not null default 1 references public.qiunai_ichiban_rounds(id);
alter table public.qiunai_ichiban_tickets add column if not exists round_id integer not null default 1 references public.qiunai_ichiban_rounds(id);
alter table public.qiunai_ichiban_tickets add column if not exists retired_at timestamptz;
alter table public.qiunai_ichiban_draws add column if not exists round_id integer not null default 1 references public.qiunai_ichiban_rounds(id);
alter table public.qiunai_ichiban_rounds enable row level security;
revoke all on public.qiunai_ichiban_rounds from anon,authenticated;
create index if not exists qiunai_ichiban_active_tickets_idx on public.qiunai_ichiban_tickets(round_id,ticket_no) where draw_id is null and retired_at is null;
create or replace function public.qiunai_ichiban_ticket_weight(p_prize_id text)
returns numeric language sql stable security definer set search_path=public as $$
 select case when p.tier in('S','A','B') then r.high_tier_weight else 1 end
 from public.qiunai_ichiban_prizes p cross join public.qiunai_ichiban_pool_mutex m
 join public.qiunai_ichiban_rounds r on r.id=m.active_round_id where m.id=1 and p.id=p_prize_id;
$$;
create or replace function public.qiunai_ichiban_stamp_round()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 select round_id into strict new.round_id from public.qiunai_ichiban_tickets where ticket_no=new.ticket_no;
 new.is_last_one:=false;
 return new;
end $$;
drop trigger if exists qiunai_ichiban_stamp_round on public.qiunai_ichiban_draws;
create trigger qiunai_ichiban_stamp_round before insert on public.qiunai_ichiban_draws for each row execute function public.qiunai_ichiban_stamp_round();
create or replace function public.qiunai_ichiban_refresh_round()
returns trigger language plpgsql security definer set search_path=public as $$
declare current_round integer; next_round integer; remaining_count integer; threshold integer; last_number integer;
begin
 if old.draw_id is not null or new.draw_id is null then return new; end if;
 select active_round_id into current_round from public.qiunai_ichiban_pool_mutex where id=1 for update;
 if new.round_id<>current_round then return new; end if;
 select refresh_remaining into threshold from public.qiunai_ichiban_rounds where id=current_round;
 select count(*) into remaining_count from public.qiunai_ichiban_tickets where round_id=current_round and draw_id is null and retired_at is null;
 if remaining_count>threshold then return new; end if;
 update public.qiunai_ichiban_tickets set retired_at=now() where round_id=current_round and draw_id is null and retired_at is null;
 update public.qiunai_ichiban_rounds set closed_at=now() where id=current_round;
 next_round:=current_round+1;
 insert into public.qiunai_ichiban_rounds(id,refresh_remaining,high_tier_weight,last_one_enabled)
 select next_round,refresh_remaining,high_tier_weight,false from public.qiunai_ichiban_rounds where id=current_round;
 select coalesce(max(ticket_no),0) into last_number from public.qiunai_ichiban_tickets;
 insert into public.qiunai_ichiban_tickets(ticket_no,prize_id,round_id)
 select last_number+row_number() over(order by p.id,n)::integer,p.id,next_round
 from public.qiunai_ichiban_prizes p cross join lateral generate_series(1,p.initial_quantity) n;
 update public.qiunai_ichiban_pool_mutex set active_round_id=next_round where id=1;
 return new;
end $$;
drop trigger if exists qiunai_ichiban_refresh_round on public.qiunai_ichiban_tickets;
create trigger qiunai_ichiban_refresh_round after update of draw_id on public.qiunai_ichiban_tickets for each row when(old.draw_id is null and new.draw_id is not null) execute function public.qiunai_ichiban_refresh_round();
CREATE OR REPLACE FUNCTION public.qiunai_ichiban_stock()
 RETURNS TABLE(prize_id text, remaining bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.prize_id, count(*)::bigint
  from public.qiunai_ichiban_tickets t
  where t.draw_id is null and t.retired_at is null
  group by t.prize_id;
$function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_draw_asd(p_discord_user_id text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare existing public.qiunai_ichiban_draws%rowtype; ticket public.qiunai_ichiban_tickets%rowtype; v_draw_id uuid; balance_after integer; prize_credit integer := 0; last_one boolean; v_remaining integer; v_pending integer;
begin
  if p_discord_user_id !~ '^[0-9]{15,25}$' or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception '一番賞請求資料格式錯誤'; end if;
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into existing from public.qiunai_ichiban_draws where payment_provider='asd' and payment_reference=p_request_id;
  if found then
    if existing.discord_user_id <> p_discord_user_id then raise exception '一番賞請求編號已被其他使用者使用'; end if;
    return jsonb_build_object('already_processed',true,'draw_id',existing.id,'prize_id',existing.prize_id,'ticket_no',existing.ticket_no,'is_last_one',existing.is_last_one);
  end if;
  select count(*) into v_remaining from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  select count(*) into v_pending from public.qiunai_ichiban_web_orders where (status='pending' and created_at > now()-interval '45 minutes') or (status='processing' and updated_at > now()-interval '24 hours');
  if v_remaining <= v_pending then raise exception '一番賞抽紙已售完或正在付款中'; end if;
  select * into ticket from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null order by -ln(greatest(random(),0.000000000000001))/public.qiunai_ichiban_ticket_weight(prize_id) limit 1;
  if not found then raise exception '一番賞已全數抽完'; end if;
  select count(*)=1 into last_one from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  insert into public.users(user_id,coins) values(p_discord_user_id,0) on conflict(user_id) do nothing;
  update public.users set coins=coalesce(coins,0)-300 where user_id=p_discord_user_id and coalesce(coins,0)>=300 returning coins into balance_after;
  if not found then raise exception 'ASD 餘額不足'; end if;
  insert into public.wallet_logs(user_id,type,amount,balance,note) values(p_discord_user_id,'扣款',-300,balance_after,'秋奈一番賞｜'||p_request_id);
  insert into public.qiunai_ichiban_draws(discord_user_id,payment_provider,payment_reference,paid_amount,prize_id,ticket_no,is_last_one) values(p_discord_user_id,'asd',p_request_id,300,ticket.prize_id,ticket.ticket_no,last_one) returning id into v_draw_id;
  update public.qiunai_ichiban_tickets set draw_id=v_draw_id,drawn_at=now() where ticket_no=ticket.ticket_no;
  if ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
    prize_credit:=substring(ticket.prize_id from 'asd-([0-9]+)$')::integer;
    update public.users set coins=coins+prize_credit where user_id=p_discord_user_id returning coins into balance_after;
    insert into public.wallet_logs(user_id,type,amount,balance,note) values(p_discord_user_id,'抽獎獎品',prize_credit,balance_after,'秋奈一番賞 ASD 獎品｜'||v_draw_id);
  end if;
  return jsonb_build_object('already_processed',false,'draw_id',v_draw_id,'prize_id',ticket.prize_id,'ticket_no',ticket.ticket_no,'is_last_one',last_one,'balance',balance_after);
end; $function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_with_ticket(p_user_id text, p_request_id text, p_use_ticket boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare saved public.qiunai_draw_redemptions%rowtype; item_id bigint; ticket public.qiunai_ichiban_tickets%rowtype; v_draw_id uuid; last_one boolean; answer jsonb; prize_credit integer; balance_after integer;
begin
 if p_user_id is null or p_user_id !~ '^[0-9]{15,25}$' or p_request_id is null or p_request_id !~ '^[0-9a-f-]{36}$' or p_use_ticket is null then raise exception '抽獎請求無效'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-draw-user:'||p_user_id,0));
 select * into saved from public.qiunai_draw_redemptions where kind='ichiban' and request_id=p_request_id;
 if found then if saved.user_id<>p_user_id then raise exception '抽獎請求不屬於你'; end if; return saved.result||jsonb_build_object('already_processed',true); end if;
 if not p_use_ticket then
  answer:=public.qiunai_ichiban_draw_asd(p_user_id,p_request_id)||jsonb_build_object('tickets_used',0,'cost',300);
 else
  if exists(select 1 from public.qiunai_ichiban_draws where payment_reference=p_request_id) then raise exception '這次抽獎已處理，請查看最近一抽'; end if;
  select id into item_id from public.user_items where user_id=p_user_id and guild_id='1206138511535898654' and item_type='ticket' and item_name in('秋奈一番賞抽獎券','秋奈一番賞抽獎劵') order by created_at,id limit 1 for update;
  if not found then raise exception '一番賞券已不足，未扣款，請重新選擇'; end if;
  perform 1 from public.qiunai_ichiban_pool_mutex where id=1 for update;
  select * into ticket from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null order by -ln(greatest(random(),0.000000000000001))/public.qiunai_ichiban_ticket_weight(prize_id) limit 1;
  if not found then raise exception '一番賞已全數抽完，未扣券'; end if;
  select count(*)=1 into last_one from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  delete from public.user_items where id=item_id;
  insert into public.qiunai_ichiban_draws(discord_user_id,payment_provider,payment_reference,paid_amount,prize_id,ticket_no,is_last_one) values(p_user_id,'ticket',p_request_id,0,ticket.prize_id,ticket.ticket_no,last_one) returning id into v_draw_id;
  update public.qiunai_ichiban_tickets set draw_id=v_draw_id,drawn_at=now() where ticket_no=ticket.ticket_no;
  if ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
   prize_credit:=substring(ticket.prize_id from 'asd-([0-9]+)$')::integer;
   insert into public.users(user_id,coins) values(p_user_id,0) on conflict(user_id) do nothing;
   update public.users set coins=coalesce(coins,0)+prize_credit where user_id=p_user_id returning coins into balance_after;
   insert into public.wallet_logs(user_id,type,amount,balance,note) values(p_user_id,'抽獎獎品',prize_credit,balance_after,'秋奈一番賞券獎品｜'||v_draw_id);
  end if;
  answer:=jsonb_build_object('already_processed',false,'draw_id',v_draw_id,'prize_id',ticket.prize_id,'ticket_no',ticket.ticket_no,'is_last_one',last_one,'tickets_used',1,'cost',0);
 end if;
 insert into public.qiunai_draw_redemptions(kind,request_id,user_id,result) values('ichiban',p_request_id,p_user_id,answer); return answer;
end $function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_begin_web_payment(p_challenge_id uuid, p_token_digest text, p_email text, p_merchant_trade_no text, p_merchant_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_identity public.qiunai_ichiban_identity_challenges%rowtype; v_remaining integer; v_pending integer; v_id uuid;
begin
  if p_email !~* '^[^ @]+@[^ @]+\.[^ @]+$' or length(p_email) > 100 or p_merchant_trade_no !~ '^[A-Za-z0-9]{1,20}$' or p_merchant_id !~ '^[0-9]{7,10}$' then raise exception '一番賞付款資料格式錯誤'; end if;
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into v_identity from public.qiunai_ichiban_identity_challenges where id = p_challenge_id and token_digest = p_token_digest and verified_at is not null and expires_at > now();
  if not found then raise exception 'Discord 驗證已過期，請重新驗證'; end if;
  select count(*) into v_remaining from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  select count(*) into v_pending from public.qiunai_ichiban_web_orders where (status='pending' and created_at > now() - interval '45 minutes') or (status='processing' and updated_at > now() - interval '24 hours');
  if v_remaining <= v_pending then raise exception '目前沒有可付款的剩餘抽紙'; end if;
  if (select count(*) from public.qiunai_ichiban_web_orders where challenge_id = p_challenge_id and ((status='pending' and created_at > now() - interval '45 minutes') or (status='processing' and updated_at > now() - interval '24 hours'))) >= 2 then raise exception '請先完成或等候既有付款單'; end if;
  insert into public.qiunai_ichiban_web_orders (merchant_trade_no,challenge_id,discord_user_id,email,merchant_id) values (p_merchant_trade_no,p_challenge_id,v_identity.discord_user_id,p_email,p_merchant_id) returning id into v_id;
  return jsonb_build_object('order_id',v_id,'merchant_trade_no',p_merchant_trade_no);
end; $function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_fulfill_web_payment(p_merchant_trade_no text, p_merchant_id text, p_gateway_trade_no text, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_order public.qiunai_ichiban_web_orders%rowtype;
  v_ticket public.qiunai_ichiban_tickets%rowtype; v_draw uuid;
  v_last boolean; v_credit integer; v_balance integer;
begin
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into v_order from public.qiunai_ichiban_web_orders
    where merchant_trade_no = p_merchant_trade_no for update;
  if not found or v_order.payment_provider <> 'ecpay'
     or v_order.merchant_id <> p_merchant_id or v_order.amount <> p_amount
     or p_gateway_trade_no !~ '^[0-9A-Za-z]{1,20}$' then
    raise exception '綠界交易與付款單不符';
  end if;
  if v_order.status = 'drawn' then
    if v_order.gateway_trade_no <> p_gateway_trade_no then raise exception '交易編號不一致'; end if;
    return jsonb_build_object('already_processed',true,'draw_id',v_order.draw_id);
  end if;
  if v_order.status = 'refund_required' then return jsonb_build_object('refund_required',true); end if;
  if v_order.status = 'failed' then raise exception '已取消付款單收到成功通知，需人工核對退款'; end if;
  select * into v_ticket from public.qiunai_ichiban_tickets
    where draw_id is null and retired_at is null order by -ln(greatest(random(),0.000000000000001))/public.qiunai_ichiban_ticket_weight(prize_id) limit 1;
  if not found then
    update public.qiunai_ichiban_web_orders set status='refund_required',
      gateway_trade_no=p_gateway_trade_no, failure_reason='付款成功但獎池已售完',updated_at=now()
      where id=v_order.id;
    return jsonb_build_object('refund_required',true);
  end if;
  select count(*)=1 into v_last from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  insert into public.qiunai_ichiban_draws
    (discord_user_id,payment_provider,payment_reference,paid_amount,prize_id,ticket_no,is_last_one)
  values (v_order.discord_user_id,'ecpay',p_merchant_trade_no,300,v_ticket.prize_id,v_ticket.ticket_no,v_last)
  returning id into v_draw;
  update public.qiunai_ichiban_tickets set draw_id=v_draw,drawn_at=now()
    where ticket_no=v_ticket.ticket_no;
  if v_ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
    v_credit:=substring(v_ticket.prize_id from 'asd-([0-9]+)$')::integer;
    insert into public.users(user_id,coins) values(v_order.discord_user_id,0)
      on conflict(user_id) do nothing;
    update public.users set coins=coalesce(coins,0)+v_credit
      where user_id=v_order.discord_user_id returning coins into v_balance;
    insert into public.wallet_logs(user_id,type,amount,balance,note)
    values(v_order.discord_user_id,'抽獎獎品',v_credit,v_balance,'秋奈一番賞網頁獎品｜'||v_draw);
  end if;
  update public.qiunai_ichiban_web_orders set status='drawn',draw_id=v_draw,
    gateway_trade_no=p_gateway_trade_no,updated_at=now() where id=v_order.id;
  return jsonb_build_object('already_processed',false,'draw_id',v_draw,
    'prize_id',v_ticket.prize_id,'ticket_no',v_ticket.ticket_no,'is_last_one',v_last);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_begin_jkopay_payment(p_challenge_id uuid, p_token_digest text, p_merchant_trade_no text, p_store_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_identity public.qiunai_ichiban_identity_challenges%rowtype;
  v_remaining integer; v_pending integer; v_id uuid;
begin
  if p_merchant_trade_no !~ '^QI[A-F0-9]{18}$' or length(p_store_id) < 3 or length(p_store_id) > 100 then
    raise exception '一番賞街口付款資料格式錯誤';
  end if;
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into v_identity from public.qiunai_ichiban_identity_challenges
    where id = p_challenge_id and token_digest = p_token_digest and verified_at is not null and expires_at > now();
  if not found then raise exception 'Discord 驗證已過期，請重新驗證'; end if;
  select count(*) into v_remaining from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  select count(*) into v_pending from public.qiunai_ichiban_web_orders
    where (status = 'pending' and created_at > now() - interval '45 minutes')
       or (status = 'processing' and updated_at > now() - interval '24 hours');
  if v_remaining <= v_pending then raise exception '目前沒有可付款的剩餘抽紙'; end if;
  if (select count(*) from public.qiunai_ichiban_web_orders where challenge_id = p_challenge_id and
       ((status = 'pending' and created_at > now() - interval '45 minutes')
        or (status = 'processing' and updated_at > now() - interval '24 hours'))) >= 2 then
    raise exception '請先完成或等候既有付款單';
  end if;
  insert into public.qiunai_ichiban_web_orders
    (merchant_trade_no,challenge_id,discord_user_id,email,merchant_id,payment_provider)
  values (p_merchant_trade_no,p_challenge_id,v_identity.discord_user_id,'',p_store_id,'jkopay')
  returning id into v_id;
  return jsonb_build_object('order_id',v_id,'merchant_trade_no',p_merchant_trade_no);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.qiunai_ichiban_fulfill_jkopay_payment(p_merchant_trade_no text, p_store_id text, p_gateway_trade_no text, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_order public.qiunai_ichiban_web_orders%rowtype;
  v_ticket public.qiunai_ichiban_tickets%rowtype; v_draw uuid;
  v_last boolean; v_credit integer; v_balance integer;
begin
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into v_order from public.qiunai_ichiban_web_orders
    where merchant_trade_no = p_merchant_trade_no for update;
  if not found or v_order.payment_provider <> 'jkopay'
     or v_order.merchant_id <> p_store_id or v_order.amount <> p_amount
     or p_gateway_trade_no !~ '^[0-9A-Za-z]{1,25}$' then
    raise exception '街口交易與付款單不符';
  end if;
  if v_order.status = 'drawn' then
    if v_order.gateway_trade_no <> p_gateway_trade_no then raise exception '交易編號不一致'; end if;
    return jsonb_build_object('already_processed',true,'draw_id',v_order.draw_id);
  end if;
  if v_order.status = 'refund_required' then return jsonb_build_object('refund_required',true); end if;
  if v_order.status = 'failed' then raise exception '已取消付款單收到成功通知，需人工核對退款'; end if;
  select * into v_ticket from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null order by -ln(greatest(random(),0.000000000000001))/public.qiunai_ichiban_ticket_weight(prize_id) limit 1;
  if not found then
    update public.qiunai_ichiban_web_orders set status='refund_required',
      gateway_trade_no=p_gateway_trade_no, failure_reason='付款成功但獎池已售完',updated_at=now() where id=v_order.id;
    return jsonb_build_object('refund_required',true);
  end if;
  select count(*)=1 into v_last from public.qiunai_ichiban_tickets where draw_id is null and retired_at is null;
  insert into public.qiunai_ichiban_draws
    (discord_user_id,payment_provider,payment_reference,paid_amount,prize_id,ticket_no,is_last_one)
  values (v_order.discord_user_id,'jkopay',p_merchant_trade_no,300,v_ticket.prize_id,v_ticket.ticket_no,v_last)
  returning id into v_draw;
  update public.qiunai_ichiban_tickets set draw_id=v_draw,drawn_at=now() where ticket_no=v_ticket.ticket_no;
  if v_ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
    v_credit:=substring(v_ticket.prize_id from 'asd-([0-9]+)$')::integer;
    insert into public.users(user_id,coins) values(v_order.discord_user_id,0) on conflict(user_id) do nothing;
    update public.users set coins=coalesce(coins,0)+v_credit
      where user_id=v_order.discord_user_id returning coins into v_balance;
    insert into public.wallet_logs(user_id,type,amount,balance,note)
    values(v_order.discord_user_id,'抽獎獎品',v_credit,v_balance,'秋奈一番賞街口獎品｜'||v_draw);
  end if;
  update public.qiunai_ichiban_web_orders set status='drawn',draw_id=v_draw,
    gateway_trade_no=p_gateway_trade_no,updated_at=now() where id=v_order.id;
  return jsonb_build_object('already_processed',false,'draw_id',v_draw,
    'prize_id',v_ticket.prize_id,'ticket_no',v_ticket.ticket_no,'is_last_one',v_last);
end;
$function$
;
create or replace function public.qiunai_ichiban_pool_status()
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('round_id',r.id,'refresh_remaining',r.refresh_remaining,'high_tier_weight',r.high_tier_weight,'last_one_enabled',r.last_one_enabled,
 'remaining',(select count(*) from public.qiunai_ichiban_tickets where round_id=r.id and draw_id is null and retired_at is null))
 from public.qiunai_ichiban_rounds r join public.qiunai_ichiban_pool_mutex m on m.active_round_id=r.id where m.id=1;
$$;
revoke all on function public.qiunai_ichiban_ticket_weight(text),public.qiunai_ichiban_stamp_round(),public.qiunai_ichiban_refresh_round() from public,anon,authenticated;
grant execute on function public.qiunai_ichiban_ticket_weight(text) to service_role;
grant execute on function public.qiunai_ichiban_pool_status() to anon,authenticated,service_role;
commit;
