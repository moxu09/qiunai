begin;
set local lock_timeout='5s';
create table if not exists public.qiunai_referral_codes (
 user_id text primary key check(user_id ~ '^[0-9]{17,20}$'),
 code text unique not null check(code ~ '^QN[A-F0-9]{16}$'), created_at timestamptz not null default now()
);
create table if not exists public.qiunai_referrals (
 invitee_id text primary key check(invitee_id ~ '^[0-9]{17,20}$'),
 inviter_id text not null references public.qiunai_referral_codes(user_id),
 code text not null, status text not null default 'pending' check(status in('pending','rewarded','ineligible')),
 purchase_key text, qualifying_order_ids uuid[], paid_amount numeric,
 inviter_item_ids bigint[], invitee_item_ids bigint[], rewarded_at timestamptz,
 last_checked_at timestamptz, created_at timestamptz not null default now(), check(invitee_id<>inviter_id)
);
alter table public.qiunai_referral_codes enable row level security;
alter table public.qiunai_referrals enable row level security;
revoke all on public.qiunai_referral_codes,public.qiunai_referrals from public,anon,authenticated;
grant all on public.qiunai_referral_codes,public.qiunai_referrals to service_role;
create index if not exists qiunai_referrals_pending on public.qiunai_referrals(last_checked_at) where status='pending';

create or replace function public.qiunai_referral_original_note(p_note text)
returns text language plpgsql immutable set search_path=public as $$
begin
 if left(coalesce(p_note,''),1)='{' then
  begin return coalesce((p_note::jsonb)->>'originalNote',p_note); exception when invalid_text_representation then return p_note; end;
 end if;
 return coalesce(p_note,'');
end $$;

-- Salary WORK rows, other stores, top-ups and invalid payments never count.
-- Multi-recipient tips and split service orders are one logical purchase.
create or replace function public.qiunai_referral_purchases(p_user_id text)
returns table(purchase_key text,paid_amount numeric,paid_at timestamp,order_ids uuid[])
language sql stable security definer set search_path=public as $$
 with wallet_raw as (
  select x->>'id' order_id,
   'tip:wallet:'||regexp_replace(o.operation_key,':([0-9]+)$','') purchase_key
  from public.tip_payment_operations o cross join lateral jsonb_array_elements(coalesce(o.result->'orders','[]')) x
  where o.guild_id='1206138511535898654' and o.user_id=p_user_id
 ), wallet as (
  select order_id,case when count(distinct purchase_key)=1 then min(purchase_key) else null end purchase_key
  from wallet_raw group by order_id
 ), base as (
  select p.*,public.qiunai_referral_original_note(p.note) original_note
  from public.play_orders p where p.guild_id='1206138511535898654' and p.customer_id=p_user_id
   and p.paid is true and coalesce(p.is_deleted,false)=false
   and coalesce(p.order_id,'') not like 'WORK-%' and coalesce(p.order_no,'') not like 'WORK-%'
   and coalesce(p.status,'') not in('cancelled','canceled','refunded','已取消','已退款')
   and coalesce(p.order_type,'訂單') in('訂單','一般訂單','打賞')
 ), keyed as (
  select p.id,coalesce(p.final_price,p.price,0)::numeric amount,coalesce(p.paid_at,p.created_at) at,
   coalesce(nullif(p.order_group_id,''),w.purchase_key,
    case when p.original_note ~ '^打賞｜manual-tip:[^:]+:[^:]+$'
      then 'tip:manual:'||split_part(split_part(p.original_note,'manual-tip:',2),':',1)
     when p.original_note ~ '^打賞｜(綠界|街口):[^:]+:[0-9]+$'
      then 'tip:'||split_part(p.original_note,'｜',2)::text -- replaced below with allocation suffix removed
     else 'order:'||p.id::text end) raw_key
  from base p left join wallet w on w.order_id=p.id::text
 ), grouped as (
  select case when raw_key ~ '^tip:(綠界|街口):[^:]+:[0-9]+$'
    then regexp_replace(raw_key,':[0-9]+$','') else raw_key end k,* from keyed
 )
 select k,sum(greatest(0,amount)),min(at),array_agg(id order by at,id)
 from grouped group by k order by min(at),min(id::text)
$$;

create or replace function public.qiunai_referral_get_code(p_user_id text)
returns text language plpgsql security definer set search_path=public as $$
declare result text;
begin
 if p_user_id is null or p_user_id !~ '^[0-9]{17,20}$' then raise exception '使用者資料不正確'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-referral-code:'||p_user_id,0));
 select code into result from public.qiunai_referral_codes where user_id=p_user_id;
 if found then return result; end if;
 loop
  result:='QN'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16));
  begin insert into public.qiunai_referral_codes(user_id,code) values(p_user_id,result); return result;
  exception when unique_violation then null; end;
 end loop;
end $$;

create or replace function public.qiunai_referral_evaluate(p_invitee_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.qiunai_referrals%rowtype; purchases integer; first_purchase record; ids bigint[];
begin
 perform pg_advisory_xact_lock(hashtextextended('qiunai-referral:'||p_invitee_id,0));
 select * into r from public.qiunai_referrals where invitee_id=p_invitee_id for update;
 if not found then return jsonb_build_object('status','unbound'); end if;
 if r.status<>'pending' then return jsonb_build_object('status',r.status,'already_granted',r.status='rewarded'); end if;
 update public.qiunai_referrals set last_checked_at=now() where invitee_id=p_invitee_id;
 select count(*) into purchases from public.qiunai_referral_purchases(p_invitee_id);
 select * into first_purchase from public.qiunai_referral_purchases(p_invitee_id) limit 1;
 if purchases=0 or first_purchase.paid_amount<500 then
  if purchases>1 then
   update public.qiunai_referrals set status='ineligible' where invitee_id=p_invitee_id;
   return jsonb_build_object('status','ineligible','reason','首單未滿500元，不以第二單補足');
  end if;
  return jsonb_build_object('status','pending','paid_amount',coalesce(first_purchase.paid_amount,0),'purchase_count',purchases);
 end if;
 with issued as (
  insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
  values(r.inviter_id,'9折優惠券','邀請獎勵','邀請新客獎勵｜限原價800元內陪玩訂單，每筆限一張；不得與限時活動併用','coupon','1206138511535898654') returning id
 ) select array_agg(id) into ids from issued;
 update public.qiunai_referrals set inviter_item_ids=ids where invitee_id=p_invitee_id;
 with issued as (
  insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
  select p_invitee_id,'9折優惠券','邀請獎勵','新客邀請獎勵｜限原價800元內陪玩訂單，每筆限一張；不得與限時活動併用','coupon','1206138511535898654' from generate_series(1,2) returning id
 ) select array_agg(id order by id) into ids from issued;
 update public.qiunai_referrals set invitee_item_ids=ids,status='rewarded',rewarded_at=now(),
  paid_amount=first_purchase.paid_amount,purchase_key=first_purchase.purchase_key,qualifying_order_ids=first_purchase.order_ids
 where invitee_id=p_invitee_id;
 return jsonb_build_object('status','rewarded','already_granted',false,'inviter_coupons',1,'invitee_coupons',2);
end $$;

create or replace function public.qiunai_referral_bind(p_invitee_id text,p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner_id text; previous public.qiunai_referrals%rowtype; purchases integer;
begin
 if p_invitee_id is null or p_invitee_id !~ '^[0-9]{17,20}$' then raise exception '使用者資料不正確'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-referral:'||p_invitee_id,0));
 select user_id into owner_id from public.qiunai_referral_codes where code=upper(trim(p_code));
 if not found then raise exception '邀請碼不存在，請確認後再輸入'; end if;
 if owner_id=p_invitee_id then raise exception '不能輸入自己的邀請碼'; end if;
 select * into previous from public.qiunai_referrals where invitee_id=p_invitee_id for update;
 if found then
  if previous.inviter_id<>owner_id then raise exception '你已綁定其他邀請碼，不能重複領取或更換邀請人'; end if;
  return public.qiunai_referral_evaluate(p_invitee_id);
 end if;
 select count(*) into purchases from public.qiunai_referral_purchases(p_invitee_id);
 if purchases>1 then raise exception '你已消費超過一單，不符合邀請碼活動資格'; end if;
 insert into public.qiunai_referrals(invitee_id,inviter_id,code) values(p_invitee_id,owner_id,upper(trim(p_code)));
 return public.qiunai_referral_evaluate(p_invitee_id);
end $$;

-- Reconciliation reads payments only. Coupon failures cannot roll back real payments.
create or replace function public.qiunai_referral_process_pending(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r record; result jsonb; processed integer:=0; rewarded integer:=0;
begin
 for r in select invitee_id from public.qiunai_referrals where status='pending'
  order by last_checked_at nulls first,created_at limit greatest(1,least(coalesce(p_limit,100),200))
 loop
  if not pg_try_advisory_xact_lock(hashtextextended('qiunai-referral:'||r.invitee_id,0)) then continue; end if;
  result:=public.qiunai_referral_evaluate(r.invitee_id); processed:=processed+1;
  if result->>'status'='rewarded' then rewarded:=rewarded+1; end if;
 end loop;
 return jsonb_build_object('processed',processed,'rewarded',rewarded);
end $$;
revoke all on function public.qiunai_referral_original_note(text),public.qiunai_referral_purchases(text),
 public.qiunai_referral_get_code(text),public.qiunai_referral_evaluate(text),public.qiunai_referral_bind(text,text),public.qiunai_referral_process_pending(integer) from public,anon,authenticated;
grant execute on function public.qiunai_referral_get_code(text),public.qiunai_referral_bind(text,text),
 public.qiunai_referral_process_pending(integer),public.qiunai_referral_evaluate(text),public.qiunai_referral_purchases(text) to service_role;
notify pgrst,'reload schema';
commit;
