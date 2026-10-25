begin;
set local lock_timeout='5s';
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
  select p.id,p.created_at,coalesce(p.final_price,p.price,0)::numeric amount,coalesce(p.paid_at,p.created_at) at,
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
 from grouped group by k order by min(at),min(created_at),min(id::text)
$$;

create or replace function public.qiunai_referral_evaluate(p_invitee_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.qiunai_referrals%rowtype; purchases integer; first_purchase record; ids bigint[];
begin
 perform pg_advisory_xact_lock(hashtextextended('qiunai-referral:'||p_invitee_id,0));
 select * into r from public.qiunai_referrals where invitee_id=p_invitee_id for update;
 if not found then return jsonb_build_object('status','unbound'); end if;
 if r.status<>'pending' then return jsonb_build_object('status',r.status,'already_granted',r.status='rewarded'); end if;
 update public.qiunai_referrals set last_checked_at=now(),last_error=null where invitee_id=p_invitee_id;
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

commit;
