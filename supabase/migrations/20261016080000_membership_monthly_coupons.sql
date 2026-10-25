begin;
set local lock_timeout='5s';
create table if not exists public.qiunai_membership_monthly_coupons(
 guild_id text not null default '1206138511535898654' check(guild_id='1206138511535898654'),
 user_id text not null,billing_month date not null,level_key text not null,
 item_name text not null,coupon_count integer not null check(coupon_count>0),item_ids bigint[] not null,
 notification_status text not null default 'pending' check(notification_status in('pending','sending','sent','blocked','left','failed')),
 attempt_count integer not null default 0,attempted_at timestamptz,dm_channel_id text,dm_message_id text,
 sent_at timestamptz,last_error text,created_at timestamptz not null default now(),
 primary key(guild_id,user_id,billing_month),check(extract(day from billing_month)=1)
);
alter table public.qiunai_membership_monthly_coupons enable row level security;
revoke all on public.qiunai_membership_monthly_coupons from public,anon,authenticated;
grant all on public.qiunai_membership_monthly_coupons to service_role;

create or replace function public.qiunai_grant_monthly_coupons(p_user_id text,p_billing_month date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare local_now timestamp:=now() at time zone 'Asia/Taipei'; current_month date;
 previous public.qiunai_membership_monthly_coupons%rowtype; member public.user_vips%rowtype;
 ids bigint[];
begin
 current_month:=date_trunc('month',local_now)::date;
 if p_user_id is null or p_user_id !~ '^[0-9]{15,25}$' or p_billing_month is null then raise exception '月領優惠券資料無效'; end if;
 if p_billing_month<'2026-11-01'::date or p_billing_month<>current_month
 then raise exception '僅開放自2026年11月起的當月優惠券，不回溯補發其他月份'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-monthly-coupon:'||p_user_id||':'||p_billing_month,0));
 select * into previous from public.qiunai_membership_monthly_coupons
 where guild_id='1206138511535898654' and user_id=p_user_id and billing_month=p_billing_month for update;
 if found then return to_jsonb(previous)||jsonb_build_object('granted',true,'already_granted',true); end if;
 if extract(day from local_now)<>1 then raise exception '每月1日自動發放，非發放日不新發券'; end if;
 select * into member from public.user_vips where guild_id='1206138511535898654' and user_id=p_user_id for update;
 if not found or member.level_key is distinct from 'vip8' then return jsonb_build_object('granted',false,'reason','ineligible'); end if;
 if not exists(select 1 from public.vip_levels where guild_id='1206138511535898654' and level_key='vip8' and membership_policy_version='20261016')
 then raise exception '月領優惠券對應的會員制度未啟用，停止發放'; end if;
 with issued as(
  insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
  select p_user_id,'95折優惠券','VIP','會員每月福利｜'||to_char(p_billing_month,'YYYY-MM')||'｜熟稔 Lv3｜限原價500元內訂單，每筆限一張','coupon','1206138511535898654'
  from generate_series(1,3) returning id
 ) select array_agg(id order by id) into ids from issued;
 insert into public.qiunai_membership_monthly_coupons(guild_id,user_id,billing_month,level_key,item_name,coupon_count,item_ids)
 values('1206138511535898654',p_user_id,p_billing_month,'vip8','95折優惠券',3,ids)
 returning * into previous;
 return to_jsonb(previous)||jsonb_build_object('granted',true,'already_granted',false);
end $$;
revoke all on function public.qiunai_grant_monthly_coupons(text,date) from public,anon,authenticated;
grant execute on function public.qiunai_grant_monthly_coupons(text,date) to service_role;
commit;
