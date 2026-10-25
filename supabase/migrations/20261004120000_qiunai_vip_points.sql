begin;
create table if not exists public.qiunai_vip_point_accounts (
  user_id text primary key, balance integer not null default 0 check(balance >= 0), updated_at timestamptz not null default now()
);
create table if not exists public.qiunai_vip_point_checkouts (
  checkout_key text primary key, user_id text not null references public.qiunai_vip_point_accounts(user_id),
  coupon_amount integer not null check(coupon_amount >= 0), points integer not null check(points >= 0),
  status text not null check(status in ('held','committed','released')),
  order_ids uuid[] not null default '{}', expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.qiunai_vip_point_logs (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  operation_key text not null unique, amount integer not null, note text not null, created_at timestamptz not null default now()
);
create table if not exists public.qiunai_vip_points_levels (
  level_key text primary key, total_spend_required integer not null,
  single_topup_required integer not null, reward_points integer not null,
  effective_at timestamptz not null default '2026-10-10 00:00:00+08'
);
insert into public.qiunai_vip_points_levels(level_key,total_spend_required,single_topup_required,reward_points) values
('vip1',9999,9999,100),('vip2',13214,13000,500),('vip3',20999,19999,1314),
('vip4',32017,31000,2599),('vip5',66666,65000,3800),('vip6',88888,86000,5200),
('vip7',111111,105000,8888),('vip8',131420,121420,9999),('vip9',177367,165000,11111),
('vip10',201314,188888,13140),('vvip1',334420,304420,18888),('vvip2',511314,480000,23344),
('vvip3',777777,700000,33440),('vvip4',921314,820000,45688),('vvip5',1314520,1200000,52000)
on conflict(level_key) do update set total_spend_required=excluded.total_spend_required,
single_topup_required=excluded.single_topup_required,reward_points=excluded.reward_points;
alter table public.qiunai_vip_point_accounts enable row level security;
alter table public.qiunai_vip_point_checkouts enable row level security;
alter table public.qiunai_vip_point_logs enable row level security;
alter table public.qiunai_vip_points_levels enable row level security;
alter table public.play_orders add column if not exists vip_point_checkout_key text;
alter table public.play_orders add column if not exists vip_points_disabled boolean not null default false;
alter table public.play_orders add column if not exists vip_points_used integer not null default 0;
alter table public.bot_vip_reward_operations add column if not exists reward_points integer not null default 0;
alter table public.vip_upgrade_logs add column if not exists reward_points integer not null default 0;

create or replace function public.qiunai_reserve_vip_points(p_user_id text,p_key text,p_coupon_amount integer,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.qiunai_vip_point_checkouts%rowtype; b integer; n integer; expired integer;
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
  n:=case when p_enabled then least(b,p_coupon_amount/2) else 0 end;
  update public.qiunai_vip_point_accounts set balance=b-n,updated_at=now() where user_id=p_user_id;
  insert into public.qiunai_vip_point_checkouts(checkout_key,user_id,coupon_amount,points,status,expires_at)
    values(p_key,p_user_id,p_coupon_amount,n,'held',now()+interval '1 hour')
    on conflict(checkout_key) do update set coupon_amount=excluded.coupon_amount,points=excluded.points,status='held',expires_at=excluded.expires_at,updated_at=now();
  return jsonb_build_object('points',n,'amount_due',p_coupon_amount-n,'balance',b-n,'checkout_key',p_key);
end $$;

create or replace function public.qiunai_bind_vip_points(p_user_id text,p_key text,p_order_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare r public.qiunai_vip_point_checkouts%rowtype; total_due integer; valid_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||p_user_id,0));
  select * into r from public.qiunai_vip_point_checkouts where checkout_key=p_key and user_id=p_user_id for update;
  if not found then raise exception '點數保留紀錄不存在'; end if;
  if r.status <> 'held' then raise exception '點數保留已失效'; end if;
  if cardinality(p_order_ids)=0 or cardinality(p_order_ids) is null then raise exception '缺少點數訂單'; end if;
  perform 1 from public.play_orders where id=any(p_order_ids) order by id for update;
  select count(*),sum(coalesce(final_price,price)) into valid_count,total_due from public.play_orders
    where id=any(p_order_ids) and customer_id=p_user_id and guild_id='1206138511535898654'
      and not coalesce(paid,false) and not coalesce(is_deleted,false)
      and (vip_point_checkout_key is null or vip_point_checkout_key=p_key);
  if valid_count<>cardinality(p_order_ids) or total_due<>r.coupon_amount-r.points then raise exception '點數折抵訂單金額不一致'; end if;
  if cardinality(r.order_ids)>0 and not (r.order_ids @> p_order_ids and r.order_ids <@ p_order_ids) then raise exception '同一點數折抵不能綁定不同訂單'; end if;
  update public.qiunai_vip_point_checkouts set order_ids=p_order_ids,expires_at=null,updated_at=now() where checkout_key=p_key;
  with parts as (
    select id,row_number() over(order by id) as rn,
      case when total_due=0 then 0 else floor(r.points::numeric*coalesce(final_price,price)/total_due)::integer end as piece
    from public.play_orders where id=any(p_order_ids)
  ), allocated as (
    select id,case when rn=valid_count then r.points-sum(piece) filter(where rn<valid_count) over() else piece end as used_points
    from parts
  )
  update public.play_orders o set vip_point_checkout_key=p_key,
    vip_points_used=coalesce(a.used_points,r.points),
    discount_amount=greatest(0,coalesce(o.original_price,o.price)-coalesce(o.final_price,o.price)-coalesce(a.used_points,r.points))
    from allocated a where o.id=a.id;
end $$;

create or replace function public.qiunai_finish_vip_points()
returns trigger language plpgsql security definer set search_path=public as $$
declare r public.qiunai_vip_point_checkouts%rowtype; all_paid boolean; all_cancelled boolean;
begin
  if new.guild_id is distinct from '1206138511535898654' or new.vip_point_checkout_key is null then return new; end if;
  select * into r from public.qiunai_vip_point_checkouts where checkout_key=new.vip_point_checkout_key for update;
  if not found then raise exception '點數折抵紀錄不存在'; end if;
  select bool_and(coalesce(paid,false)),bool_and((not coalesce(paid,false) and coalesce(is_deleted,false)) or status in('cancelled','canceled','abandoned','refunded'))
    into all_paid,all_cancelled from public.play_orders where id=any(r.order_ids);
  if all_cancelled and r.status in('held','committed') then
    update public.qiunai_vip_point_accounts set balance=balance+r.points,updated_at=now() where user_id=r.user_id;
    update public.qiunai_vip_point_checkouts set status='released',updated_at=now() where checkout_key=r.checkout_key;
    insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note) values(r.user_id,'refund:'||r.checkout_key,r.points,'取消訂單退回折抵點數') on conflict do nothing;
  elsif all_paid and r.status='held' then
    update public.qiunai_vip_point_checkouts set status='committed',updated_at=now() where checkout_key=r.checkout_key;
    insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note) values(r.user_id,'spend:'||r.checkout_key,-r.points,'付款完成點數折抵') on conflict do nothing;
  elsif all_paid and not all_cancelled and r.status='released' then raise exception '點數已退回，不能付款；請重新開單';
  end if;
  return new;
end $$;
create or replace trigger qiunai_finish_vip_points after update of paid,status,is_deleted on public.play_orders
for each row execute function public.qiunai_finish_vip_points();

-- Preserve the current atomic ASD implementation before cutover.
do $$ begin
 if to_regprocedure('public.qiunai_apply_vip_level_reward_legacy_20261010(text,text,text,text,text,numeric,jsonb)') is null then
   alter function public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb) rename to qiunai_apply_vip_level_reward_legacy_20261010;
 end if;
end $$;
create or replace function public.qiunai_apply_vip_level_reward(p_guild_id text,p_user_id text,p_level_key text,p_old_level_key text,p_trigger_type text,p_trigger_amount numeric,p_reward_coupons jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.bot_vip_reward_operations%rowtype; l public.vip_levels%rowtype; n integer; b integer; coupon jsonb; reward_note_text text; spend_threshold integer; topup_threshold integer;
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
revoke all on function public.qiunai_reserve_vip_points(text,text,integer,boolean),public.qiunai_bind_vip_points(text,text,uuid[]),public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.qiunai_reserve_vip_points(text,text,integer,boolean),public.qiunai_bind_vip_points(text,text,uuid[]),public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb) to service_role;
commit;
