begin;
set local lock_timeout='5s';
create or replace function public.qiunai_award_extension_cashback(p_id bigint)
returns boolean language plpgsql security definer set search_path=public as $$
declare e public.order_extensions%rowtype; p public.play_orders%rowtype; r public.qiunai_membership_cashbacks%rowtype;
 active timestamptz; award numeric; debt numeric; repaid numeric; added numeric;
begin
 select * into e from public.order_extensions where id=p_id;
 if not found or e.guild_id is distinct from '1206138511535898654' or not coalesce(e.paid,false)
 or e.status in('cancelled','canceled','refunded','abandoned','已取消','已退款') then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||e.customer_id,0));
 if exists(select 1 from public.qiunai_membership_extension_cashbacks where extension_id=e.id) then return false; end if;
 select * into p from public.play_orders where id::text=e.order_id::text;
 if not found or p.guild_id is distinct from e.guild_id or p.customer_id is distinct from e.customer_id
 or not coalesce(p.paid,false) or coalesce(p.is_deleted,false)
 or p.status in('cancelled','canceled','refunded','abandoned','已取消','已退款') then return false; end if;
 select * into r from public.qiunai_membership_cashbacks where order_id=p.id and reversed_at is null;
 if not found then return false; end if;
 select activated_at into active from public.qiunai_membership_policy_archive where version='20261016';
 if active is null or e.paid_at is null or e.paid_at<active or e.paid_at<r.created_at or coalesce(e.amount,0)<=0 then return false; end if;
 -- Only incremental extensions paid after the original award. Never count an amount
 -- already inside the main award, nor silently accept inconsistent order totals.
 select coalesce(sum(amount),0) into added from public.order_extensions
 where order_id::text=p.id::text and paid and paid_at>=r.created_at
 and status not in('cancelled','canceled','refunded','abandoned','已取消','已退款');
 if r.paid_amount+added>coalesce(p.final_price,p.price,0) then return false; end if;
 award:=round(e.amount*r.rate/100,2);
 insert into public.qiunai_membership_point_debts(user_id) values(e.customer_id) on conflict do nothing;
 select points into debt from public.qiunai_membership_point_debts where user_id=e.customer_id for update;
 repaid:=least(award,debt);
 update public.qiunai_membership_point_debts set points=points-repaid,updated_at=now() where user_id=e.customer_id;
 insert into public.qiunai_membership_extension_cashbacks(extension_id,order_id,user_id,rate,paid_amount,points,debt_repaid)
 values(e.id,p.id,e.customer_id,r.rate,e.amount,award,repaid);
 insert into public.qiunai_vip_point_accounts(user_id,balance) values(e.customer_id,award-repaid)
 on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+excluded.balance,updated_at=now();
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(e.customer_id,'membership-cashback:extension:'||e.id,award-repaid,'加時 #'||e.id||' 消費回饋 '||r.rate||'%；按原單回饋比率，沖抵欠點 '||repaid);
 return true;
end $$;
revoke all on function public.qiunai_award_extension_cashback(bigint) from public,anon,authenticated;
grant execute on function public.qiunai_award_extension_cashback(bigint) to service_role;
create or replace function public.qiunai_extension_cashback_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
declare eid bigint;
begin
 if new.guild_id is distinct from '1206138511535898654' then return new; end if;
 if tg_table_name='order_extensions' then perform public.qiunai_award_extension_cashback(new.id);
 else
  for eid in select id from public.order_extensions where order_id::text=new.id::text and paid order by id loop
   perform public.qiunai_award_extension_cashback(eid);
  end loop;
 end if;
 return new;
end $$;
revoke all on function public.qiunai_extension_cashback_trigger() from public,anon,authenticated;
drop trigger if exists qiunai_z_extension_cashback on public.order_extensions;
create trigger qiunai_z_extension_cashback after insert or update of paid,status on public.order_extensions
 for each row execute function public.qiunai_extension_cashback_trigger();
drop trigger if exists qiunai_z_extension_cashback on public.play_orders;
create trigger qiunai_z_extension_cashback after update of paid,status,price,final_price on public.play_orders
 for each row execute function public.qiunai_extension_cashback_trigger();
commit;
