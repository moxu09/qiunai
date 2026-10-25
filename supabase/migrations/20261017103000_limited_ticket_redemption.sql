begin;
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
  if pool.pool_name !~ '殺[比必]死|限定' then raise exception '這張券不能用於此卡池'; end if;
  select array_agg(id) into ids from (
   select id from public.user_items where user_id=p_user_id and guild_id=p_guild_id and item_type='ticket'
   and ((pool.pool_name ~ '殺[比必]死' and item_name in('殺比死卡池抽獎券','殺比死卡池抽獎劵','殺必死卡池抽獎券','殺必死卡池抽獎劵'))
   or (pool.pool_name ~ '限定' and item_name in('限定卡池抽獎券','限定卡池抽獎劵','限定卡池獎券','限定卡池獎劵')))
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
commit;
