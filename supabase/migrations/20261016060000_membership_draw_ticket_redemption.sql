begin;
set local lock_timeout='5s';
create table if not exists public.qiunai_draw_redemptions(
 kind text not null,request_id text not null,user_id text not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(kind,request_id)
);
alter table public.qiunai_draw_redemptions enable row level security;
revoke all on public.qiunai_draw_redemptions from public,anon,authenticated;
grant all on public.qiunai_draw_redemptions to service_role;

create or replace function public.qiunai_gacha_with_tickets(
 p_user_id text,p_guild_id text,p_request_id text,p_pool_id integer,p_amount integer,
 p_ticket_count integer,p_expected_price integer,p_reward_coins integer,p_rewards jsonb,p_results jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare saved public.qiunai_draw_redemptions%rowtype; pool public.gacha_pools%rowtype;
 ids bigint[]; cost integer; balance_after integer; answer jsonb;
begin
 if p_guild_id is distinct from '1206138511535898654' or p_user_id !~ '^[0-9]{15,25}$'
 or p_user_id is null or p_request_id is null or p_request_id !~ '^[0-9a-f-]{36}$'
 or p_amount is null or p_amount not in(1,10) or p_ticket_count is null or p_ticket_count not between 0 and p_amount
 or p_reward_coins is null or p_reward_coins<0 then raise exception '抽獎資料無效'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-draw-user:'||p_user_id,0));
 select * into saved from public.qiunai_draw_redemptions where kind='gacha' and request_id=p_request_id;
 if found then
  if saved.user_id<>p_user_id then raise exception '抽獎請求不屬於你'; end if;
  return saved.result||jsonb_build_object('already_processed',true);
 end if;
 select * into pool from public.gacha_pools where id=p_pool_id for share;
 if not found or pool.price is null or pool.price<=0 then raise exception '卡池不存在或價格無效'; end if;
 if p_expected_price is distinct from pool.price then raise exception '卡池價格已變更，請重新選擇，未扣券也未扣款'; end if;
 if p_ticket_count>0 then
  if pool.pool_name !~ '殺[比必]死' then raise exception '這張券不能用於此卡池'; end if;
  select array_agg(id) into ids from (
   select id from public.user_items where user_id=p_user_id and guild_id=p_guild_id and item_type='ticket'
   and item_name in('殺比死卡池抽獎券','殺比死卡池抽獎劵','殺必死卡池抽獎券','殺必死卡池抽獎劵')
   order by created_at,id limit p_ticket_count for update
  ) t;
  if coalesce(cardinality(ids),0)<>p_ticket_count then raise exception '抽獎券已不足，未扣券也未扣款，請重新選擇'; end if;
 end if;
 cost:=(p_amount-p_ticket_count)*pool.price;
 insert into public.users(user_id,coins) values(p_user_id,0) on conflict(user_id) do nothing;
 update public.users set coins=coalesce(coins,0)-cost+p_reward_coins
 where user_id=p_user_id and coalesce(coins,0)>=cost returning coins into balance_after;
 if not found then raise exception '星雨幣不足，未扣券也未扣款'; end if;
 delete from public.user_items where id=any(ids);
 insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
 select p_user_id,r.item_name,r.rarity,r.description,r.item_type,p_guild_id
 from jsonb_to_recordset(coalesce(p_rewards,'[]')) r(item_name text,rarity text,description text,item_type text);
 insert into public.wallet_logs(user_id,type,amount,balance,note)
 values(p_user_id,'扭蛋',p_reward_coins-cost,balance_after,'秋奈卡池｜'||p_request_id||'｜使用券 '||p_ticket_count||' 張；扣款 '||cost||' ASD');
 answer:=jsonb_build_object('results',p_results,'totalRewardCoins',p_reward_coins,'finalCoins',balance_after,
  'cost',cost,'ticketsUsed',p_ticket_count,'logged',true,'already_processed',false);
 insert into public.qiunai_draw_redemptions(kind,request_id,user_id,result) values('gacha',p_request_id,p_user_id,answer);
 return answer;
end $$;
revoke all on function public.qiunai_gacha_with_tickets(text,text,text,integer,integer,integer,integer,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qiunai_gacha_with_tickets(text,text,text,integer,integer,integer,integer,integer,jsonb,jsonb) to service_role;

alter table public.qiunai_ichiban_draws drop constraint if exists qiunai_ichiban_draws_payment_provider_check;
alter table public.qiunai_ichiban_draws add constraint qiunai_ichiban_draws_payment_provider_check check(payment_provider in('asd','ecpay','jkopay','ticket'));
alter table public.qiunai_ichiban_draws drop constraint if exists qiunai_ichiban_draws_paid_amount_check;
alter table public.qiunai_ichiban_draws add constraint qiunai_ichiban_draws_paid_amount_check
 check((payment_provider='ticket' and paid_amount=0) or (payment_provider<>'ticket' and paid_amount=300));
create unique index if not exists qiunai_ichiban_request_unique on public.qiunai_ichiban_draws(payment_reference);

create or replace function public.qiunai_ichiban_with_ticket(p_user_id text,p_request_id text,p_use_ticket boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare saved public.qiunai_draw_redemptions%rowtype; item_id bigint;
 ticket public.qiunai_ichiban_tickets%rowtype; v_draw_id uuid; last_one boolean;
 answer jsonb; prize_credit integer; balance_after integer;
begin
 if p_user_id is null or p_user_id !~ '^[0-9]{15,25}$' or p_request_id is null or p_request_id !~ '^[0-9a-f-]{36}$'
 or p_use_ticket is null then raise exception '抽獎請求無效'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-draw-user:'||p_user_id,0));
 select * into saved from public.qiunai_draw_redemptions where kind='ichiban' and request_id=p_request_id;
 if found then
  if saved.user_id<>p_user_id then raise exception '抽獎請求不屬於你'; end if;
  return saved.result||jsonb_build_object('already_processed',true);
 end if;
 if not p_use_ticket then
  answer:=public.qiunai_ichiban_draw_asd(p_user_id,p_request_id)||jsonb_build_object('tickets_used',0,'cost',300);
 else
  -- Old paid confirmation buttons use the original RPC. Never redeem a second time for that same request.
  if exists(select 1 from public.qiunai_ichiban_draws where payment_reference=p_request_id) then raise exception '這次抽獎已處理，請查看最近一抽'; end if;
  select id into item_id from public.user_items where user_id=p_user_id and guild_id='1206138511535898654'
  and item_type='ticket' and item_name in('秋奈一番賞抽獎券','秋奈一番賞抽獎劵') order by created_at,id limit 1 for update;
  if not found then raise exception '一番賞券已不足，未扣款，請重新選擇'; end if;
  perform 1 from public.qiunai_ichiban_pool_mutex where id=1 for update;
  select * into ticket from public.qiunai_ichiban_tickets where draw_id is null order by random() limit 1;
  if not found then raise exception '一番賞已全數抽完，未扣券'; end if;
  select count(*)=1 into last_one from public.qiunai_ichiban_tickets where draw_id is null;
  delete from public.user_items where id=item_id;
  insert into public.qiunai_ichiban_draws(discord_user_id,payment_provider,payment_reference,paid_amount,prize_id,ticket_no,is_last_one)
  values(p_user_id,'ticket',p_request_id,0,ticket.prize_id,ticket.ticket_no,last_one) returning id into v_draw_id;
  update public.qiunai_ichiban_tickets set draw_id=v_draw_id,drawn_at=now() where ticket_no=ticket.ticket_no;
  if ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
   prize_credit:=substring(ticket.prize_id from 'asd-([0-9]+)$')::integer;
   insert into public.users(user_id,coins) values(p_user_id,0) on conflict(user_id) do nothing;
   update public.users set coins=coalesce(coins,0)+prize_credit where user_id=p_user_id returning coins into balance_after;
   insert into public.wallet_logs(user_id,type,amount,balance,note) values(p_user_id,'抽獎獎品',prize_credit,balance_after,'秋奈一番賞券獎品｜'||v_draw_id);
  end if;
  answer:=jsonb_build_object('already_processed',false,'draw_id',v_draw_id,'prize_id',ticket.prize_id,'ticket_no',ticket.ticket_no,'is_last_one',last_one,'tickets_used',1,'cost',0);
 end if;
 insert into public.qiunai_draw_redemptions(kind,request_id,user_id,result) values('ichiban',p_request_id,p_user_id,answer);
 return answer;
end $$;
revoke all on function public.qiunai_ichiban_with_ticket(text,text,boolean) from public,anon,authenticated;
grant execute on function public.qiunai_ichiban_with_ticket(text,text,boolean) to service_role;
commit;
