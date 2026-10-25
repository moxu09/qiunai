begin;
set local lock_timeout='5s';
alter table public.qiunai_vip_point_accounts alter column balance type numeric(20,2) using balance::numeric;
alter table public.qiunai_vip_point_logs alter column amount type numeric(20,2) using amount::numeric;
alter table public.qiunai_membership_cashbacks alter column points type numeric(20,2) using points::numeric;
alter table public.qiunai_membership_cashbacks alter column debt_repaid type numeric(20,2) using debt_repaid::numeric;
alter table public.qiunai_membership_point_debts alter column points type numeric(20,2) using points::numeric;
alter table public.qiunai_membership_topup_rebates alter column points type numeric(20,2) using points::numeric;
alter table public.qiunai_membership_topup_rebates alter column debt_repaid type numeric(20,2) using debt_repaid::numeric;
alter table public.qiunai_membership_extension_cashbacks alter column points type numeric(20,2) using points::numeric;
alter table public.bot_vip_reward_operations alter column final_balance type numeric(20,2) using final_balance::numeric;
alter table public.qiunai_membership_extension_cashbacks add column if not exists debt_repaid numeric(20,2) not null default 0;
create or replace function public.qiunai_membership_order_cashback()
returns trigger language plpgsql security definer set search_path=public as $$
declare l public.vip_levels%rowtype; r public.qiunai_membership_cashbacks%rowtype;
 activated timestamptz; spend numeric; topup numeric; old_sort integer; selected_rate numeric;
 amount_paid numeric; award numeric; current_balance numeric; debt numeric; repaid numeric; reclaimed numeric;
begin
 if new.guild_id is distinct from '1206138511535898654' then return new; end if;
 select activated_at into activated from public.qiunai_membership_policy_archive where version='20261016';
 if activated is null then return new; end if;
 -- Lock the same per-user key used by point checkouts and rewards.
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||new.customer_id,0));
 select * into r from public.qiunai_membership_cashbacks where order_id=new.id for update;
 if found then
   if r.reversed_at is null and (not coalesce(new.paid,false) or new.status in('cancelled','canceled','refunded')) then
     select balance into current_balance from public.qiunai_vip_point_accounts where user_id=r.user_id for update;
     reclaimed:=least(coalesce(current_balance,0),r.points-r.debt_repaid);
     update public.qiunai_vip_point_accounts set balance=balance-reclaimed,updated_at=now() where user_id=r.user_id;
     -- Reverse the award, including any previously repaid debt; never charge the wallet.
     insert into public.qiunai_membership_point_debts(user_id,points)
     values(r.user_id,r.points-reclaimed)
     on conflict(user_id) do update set points=qiunai_membership_point_debts.points+excluded.points,updated_at=now();
     insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
     values(r.user_id,'membership-refund:'||new.id,-reclaimed,'訂單取消：沖回消費點數，未收回部分於下次回饋抵扣');
     update public.qiunai_membership_cashbacks set reversed_at=now() where order_id=new.id;
   end if;
   return new;
 end if;
 if not coalesce(new.paid,false) or new.status in('cancelled','canceled','refunded') or new.customer_id is null then return new; end if;
 -- Only a new confirmed payment after activation is eligible. Issuing an ATM code is NOT payment.
 if tg_op='UPDATE' and coalesce(old.paid,false) then return new; end if;
 if coalesce(new.paid_at,now()) < activated then return new; end if;
 amount_paid:=greatest(0,coalesce(new.final_price,new.price,0));
 select v.total_spent,v.highest_single_topup,coalesce(vl.sort_order,0)
 into spend,topup,old_sort from public.user_vips v left join public.vip_levels vl
 on vl.guild_id=v.guild_id and vl.level_key=v.level_key
 where v.guild_id=new.guild_id and v.user_id=new.customer_id;
 select * into l from public.vip_levels where guild_id=new.guild_id and membership_policy_version='20261016'
 and (sort_order=coalesce(old_sort,0)
 or (not invitation_only and (total_spend_required<=coalesce(spend,0)
 or (single_topup_required>0 and single_topup_required<=coalesce(topup,0)))))
 order by sort_order desc limit 1;
 if l.level_key is null then return new; end if;
 selected_rate:=coalesce(l.cashback_rate,0)+case when coalesce(l.multi_player_min_count,0)>0
 and coalesce(new.player_count,1)>=l.multi_player_min_count then coalesce(l.multi_player_cashback_rate,0) else 0 end;
 award:=round(amount_paid*selected_rate/100,2);
 insert into public.qiunai_membership_point_debts(user_id) values(new.customer_id) on conflict do nothing;
 select points into debt from public.qiunai_membership_point_debts where user_id=new.customer_id for update;
 repaid:=least(award,debt);
 update public.qiunai_membership_point_debts set points=points-repaid,updated_at=now() where user_id=new.customer_id;
 insert into public.qiunai_membership_cashbacks(order_id,user_id,level_key,rate,paid_amount,points,debt_repaid)
 values(new.id,new.customer_id,l.level_key,selected_rate,amount_paid,award,repaid);
 insert into public.qiunai_vip_point_accounts(user_id,balance) values(new.customer_id,award-repaid)
 on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+excluded.balance,updated_at=now();
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(new.customer_id,'membership-cashback:'||new.id,award-repaid,
 l.level_name||' 消費回饋 '||selected_rate||'%；沖抵退單點數 '||repaid);
 return new;
end $$;
create or replace function public.qiunai_membership_topup_rebate()
returns trigger language plpgsql security definer set search_path=public as $$
declare row_data jsonb:=to_jsonb(new); uid text; source text; paid_time timestamptz; activated timestamptz;
 purchase numeric; month_start date; start_time timestamptz; period text; selected_plan text; selected_sort integer;
 rate integer; award numeric; debt numeric; repaid numeric; balance_now numeric; reclaimed numeric;
 existing public.qiunai_membership_topup_rebates%rowtype;
begin
 if tg_table_name='ecpay_service_payments' then
   if row_data->>'organization_code'<>'qiunai' or row_data->>'payment_kind'<>'topup' then return new; end if;
   source:='ecpay:'||(row_data->>'id');
 elsif tg_table_name='jkopay_topup_orders' then
   if coalesce(row_data->>'platform_order_id','') not like 'QIUNAI-TOP-%' then return new; end if;
   source:='jkopay:'||(row_data->>'id');
 elsif tg_table_name='bot_manual_topups' then
   if row_data->>'organization_code'<>'qiunai' then return new; end if;
   source:='manual:'||(row_data->>'topup_no');
 else raise exception '不支援的首充來源'; end if;
 uid:=row_data->>'user_id';
 if uid is null then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||uid,0));
 select * into existing from public.qiunai_membership_topup_rebates where source_key=source for update;
 if found then
   if existing.reversed_at is null and row_data->>'status'='refunded' then
     select balance into balance_now from public.qiunai_vip_point_accounts where user_id=uid for update;
     reclaimed:=least(coalesce(balance_now,0),existing.points-existing.debt_repaid);
     update public.qiunai_vip_point_accounts set balance=balance-reclaimed,updated_at=now() where user_id=uid;
     insert into public.qiunai_membership_point_debts(user_id,points) values(uid,existing.points-reclaimed)
     on conflict(user_id) do update set points=qiunai_membership_point_debts.points+excluded.points,updated_at=now();
     insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
     values(uid,'membership-topup-refund:'||source,-reclaimed,'購幣退款：沖回首充返利消費點數');
     update public.qiunai_membership_topup_rebates set reversed_at=now() where source_key=source;
   end if;
   return new;
 end if;
 if coalesce(row_data->>'status','') not in('paid','completed') then return new; end if;
 if tg_op='UPDATE' and to_jsonb(old)->>'status' in('paid','completed') then return new; end if;
 paid_time:=coalesce((row_data->>'paid_at')::timestamptz,(row_data->>'updated_at')::timestamptz,now());
 purchase:=(row_data->>'amount')::numeric;
 select activated_at into activated from public.qiunai_membership_policy_archive where version='20261016';
 if activated is null or paid_time<activated or purchase<=0 then return new; end if;
 select max(l.sort_order) into selected_sort from public.vip_levels l
 left join public.user_vips v on v.guild_id=l.guild_id and v.user_id=uid
 where l.guild_id='1206138511535898654' and l.membership_policy_version='20261016'
 and (l.level_key=v.level_key or (not l.invitation_only and
 (l.total_spend_required<=coalesce(v.total_spent,0) or
 (l.single_topup_required>0 and l.single_topup_required<=greatest(coalesce(v.highest_single_topup,0),purchase)))));
 if coalesce(selected_sort,0)<7 then return new; end if;
 month_start:=date_trunc('month',paid_time at time zone 'Asia/Taipei')::date;
 select plan into selected_plan from public.qiunai_membership_rebate_plans where user_id=uid and billing_month=month_start;
 selected_plan:=coalesce(selected_plan,'monthly');
 if selected_sort<9 then selected_plan:='monthly'; end if;
 rate:=case when selected_plan='weekly' then 1 when selected_sort>=9 then 3 else 2 end;
 start_time:=case when selected_plan='weekly' then date_trunc('week',paid_time at time zone 'Asia/Taipei')
 else month_start::timestamp end at time zone 'Asia/Taipei';
 period:=case when selected_plan='weekly' then 'W:'||to_char(start_time at time zone 'Asia/Taipei','IYYY-IW')
 else 'M:'||to_char(month_start,'YYYY-MM') end;
 if exists(select 1 from public.qiunai_membership_topup_rebates where user_id=uid and period_key=period) then return new; end if;
 -- A prior successful purchase in the same period disqualifies this purchase,
 -- even if that earlier purchase preceded the rollout or a later membership upgrade.
 if exists(select 1 from (
   select 'ecpay:'||id::text k,coalesce(paid_at,updated_at) t from public.ecpay_service_payments
    where user_id=uid and organization_code='qiunai' and payment_kind='topup' and status='paid'
   union all select 'jkopay:'||id::text,coalesce(paid_at,updated_at) from public.jkopay_topup_orders
    where user_id=uid and platform_order_id like 'QIUNAI-TOP-%' and status='paid'
   union all select 'manual:'||topup_no,updated_at from public.bot_manual_topups
    where user_id=uid and organization_code='qiunai' and status='completed'
 ) history where k<>source and t>=start_time and t<=paid_time) then return new; end if;
 award:=round(purchase*rate/100,2);
 insert into public.qiunai_membership_point_debts(user_id) values(uid) on conflict do nothing;
 select points into debt from public.qiunai_membership_point_debts where user_id=uid for update;
 repaid:=least(award,debt);
 update public.qiunai_membership_point_debts set points=points-repaid,updated_at=now() where user_id=uid;
 insert into public.qiunai_membership_topup_rebates(source_key,user_id,confirmed_at,billing_month,period_key,plan,rate,purchase_amount,points,debt_repaid)
 values(source,uid,paid_time,month_start,period,selected_plan,rate,purchase,award,repaid);
 insert into public.qiunai_vip_point_accounts(user_id,balance) values(uid,award-repaid)
 on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+excluded.balance,updated_at=now();
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(uid,'membership-topup:'||source,award-repaid,period||' 首充返利 '||rate||'%（消費點數）；沖抵欠點 '||repaid);
 return new;
end $$;
create or replace function public.qiunai_reserve_vip_points(p_user_id text,p_key text,p_coupon_amount integer,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.qiunai_vip_point_checkouts%rowtype; b numeric; n integer; expired integer;
begin
  if coalesce(p_user_id,'')='' or coalesce(p_key,'')='' or p_coupon_amount < 0 or p_coupon_amount is null then raise exception '點數折抵資料無效'; end if;
  if now() < '2026-10-10 00:00:00+08'::timestamptz then return jsonb_build_object('points',0,'amount_due',p_coupon_amount,'balance',0); end if;
  perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||p_user_id,0));
  insert into public.qiunai_vip_point_accounts(user_id) values(p_user_id) on conflict do nothing;
  with released as (update public.qiunai_vip_point_checkouts set status='released',updated_at=now()
    where user_id=p_user_id and status='held' and cardinality(order_ids)=0 and expires_at < now() returning points)
    select coalesce(sum(points),0) into expired from released;
  update public.qiunai_vip_point_accounts set balance=balance+expired where user_id=p_user_id returning balance into b;
  select * into r from public.qiunai_vip_point_checkouts where checkout_key=p_key for update;
  if found and r.user_id<>p_user_id then raise exception '點數付款不屬於此闆闆'; end if;
  if found and (r.status='committed' or cardinality(r.order_ids)>0) then
    if r.coupon_amount<>p_coupon_amount or (not p_enabled and r.points>0) or r.status='released' then raise exception '訂單已進入付款，不能更改點數'; end if;
    return jsonb_build_object('points',r.points,'amount_due',r.coupon_amount-r.points,'balance',b,'checkout_key',p_key);
  end if;
  if found and r.status='held' then b:=b+r.points; end if;
  n:=case when p_enabled then least(floor(b),p_coupon_amount/2) else 0 end;
  update public.qiunai_vip_point_accounts set balance=b-n,updated_at=now() where user_id=p_user_id;
  insert into public.qiunai_vip_point_checkouts(checkout_key,user_id,coupon_amount,points,status,expires_at)
    values(p_key,p_user_id,p_coupon_amount,n,'held',now()+interval '1 hour')
    on conflict(checkout_key) do update set coupon_amount=excluded.coupon_amount,points=excluded.points,status='held',expires_at=excluded.expires_at,updated_at=now();
  return jsonb_build_object('points',n,'amount_due',p_coupon_amount-n,'balance',b-n,'checkout_key',p_key);
end $$;
create or replace function public.qiunai_apply_vip_level_reward(p_guild_id text,p_user_id text,p_level_key text,p_old_level_key text,p_trigger_type text,p_trigger_amount numeric,p_reward_coupons jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.bot_vip_reward_operations%rowtype; l public.vip_levels%rowtype; n integer; b numeric; coupon jsonb; reward_note_text text; spend_threshold integer; topup_threshold integer;
begin
  if now()<'2026-10-10 00:00:00+08'::timestamptz then return public.qiunai_apply_vip_level_reward_legacy_20261010(p_guild_id,p_user_id,p_level_key,p_old_level_key,p_trigger_type,p_trigger_amount,p_reward_coupons); end if;
  if p_guild_id is distinct from '1206138511535898654' or coalesce(p_user_id,'')='' or p_trigger_type not in('spend','topup') then raise exception 'VIP 獎勵資料無效'; end if;
  perform pg_advisory_xact_lock(hashtextextended('qiunai-vip-reward:'||p_guild_id||':'||p_user_id||':'||p_level_key,0));
  select * into r from public.bot_vip_reward_operations where organization_code='qiunai' and guild_id=p_guild_id and user_id=p_user_id and level_key=p_level_key for update;
  if found then return to_jsonb(r)||jsonb_build_object('already_applied',true); end if;
  -- Historical ASD claims must never be granted again as points or coupons.
  if exists(select 1 from public.vip_upgrade_logs where guild_id=p_guild_id and user_id=p_user_id and new_level_key=p_level_key) then
    return jsonb_build_object('guild_id',p_guild_id,'user_id',p_user_id,'level_key',p_level_key,'already_applied',true,'historical_claim',true);
  end if;
  select * into l from public.vip_levels where guild_id=p_guild_id and level_key=p_level_key;
  select reward_points,total_spend_required,single_topup_required into n,spend_threshold,topup_threshold from public.qiunai_vip_points_levels where level_key=p_level_key;
  if l.id is null or n is null then raise exception 'VIP 點數設定不存在'; end if;
  reward_note_text := regexp_replace(regexp_replace(coalesce(l.reward_note,''),
    '累積消費[0-9,]+[T元]?或單次(儲值|充值)[0-9,]+(ASD|T|元)',
    '累積消費'||spend_threshold||'或單次購買'||topup_threshold||'ASD','g'),
    '獲得[0-9,]+ASD','獲得'||n||'點','g');
  if jsonb_typeof(coalesce(p_reward_coupons,'[]'::jsonb))<>'array' then raise exception '優惠券格式無效'; end if;
  perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||p_user_id,0));
  insert into public.qiunai_vip_point_accounts(user_id,balance) values(p_user_id,n) on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+n,updated_at=now() returning balance into b;
  insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note) values(p_user_id,'reward:'||p_user_id||':'||p_level_key,n,'升級 '||l.level_name||' 回饋點數');
  for coupon in select value from jsonb_array_elements(coalesce(p_reward_coupons,'[]'::jsonb)) loop
    if coalesce(coupon->>'name','')='' or coalesce((coupon->>'count')::integer,0) not between 1 and 100 then raise exception '優惠券內容無效'; end if;
    insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
    select p_user_id,coupon->>'name','VIP',l.level_name||' 升級獎勵','coupon',p_guild_id from generate_series(1,(coupon->>'count')::integer);
  end loop;
  insert into public.vip_upgrade_logs(guild_id,user_id,old_level_key,new_level_key,trigger_type,trigger_amount,reward_asd,reward_points,reward_coupon,reward_note)
    values(p_guild_id,p_user_id,p_old_level_key,p_level_key,p_trigger_type,coalesce(p_trigger_amount,0)::integer,0,n,l.reward_coupon,reward_note_text);
  insert into public.bot_vip_reward_operations(organization_code,guild_id,user_id,level_key,old_level_key,trigger_type,trigger_amount,reward_asd,reward_points,reward_coupons,reward_note,role_id,level_name,final_balance,delivery_status)
    values('qiunai',p_guild_id,p_user_id,p_level_key,p_old_level_key,p_trigger_type,coalesce(p_trigger_amount,0)::integer,0,n,coalesce(p_reward_coupons,'[]'::jsonb),reward_note_text,l.role_id,l.level_name,b,'pending') returning * into r;
  return to_jsonb(r)||jsonb_build_object('already_applied',false);
end $$;
create or replace function public.qiunai_reverse_extension_cashback(p_extension_id bigint)
returns void language plpgsql security definer set search_path=public as $$
declare r public.qiunai_membership_extension_cashbacks%rowtype; uid text; available numeric; reclaimed numeric;
begin
 select user_id into uid from public.qiunai_membership_extension_cashbacks where extension_id=p_extension_id;
 if not found then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||uid,0));
 select * into r from public.qiunai_membership_extension_cashbacks where extension_id=p_extension_id for update;
 if r.reversed_at is not null then return; end if;
 select balance into available from public.qiunai_vip_point_accounts where user_id=uid for update;
 reclaimed:=least(coalesce(available,0),r.points-r.debt_repaid);
 update public.qiunai_vip_point_accounts set balance=balance-reclaimed,updated_at=now() where user_id=uid;
 insert into public.qiunai_membership_point_debts(user_id,points) values(uid,r.points-reclaimed)
 on conflict(user_id) do update set points=qiunai_membership_point_debts.points+excluded.points,updated_at=now();
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(uid,'membership-refund:extension:'||p_extension_id,-reclaimed,'加時退款：沖回補發消費點數；不足部分列退單欠點');
 update public.qiunai_membership_extension_cashbacks set reversed_at=now() where extension_id=p_extension_id;
end $$;
commit;
