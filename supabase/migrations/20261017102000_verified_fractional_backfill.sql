-- Explicit user approval: restore verified fractional shortfalls and missed
-- incremental extensions only. No VIP upgrade, wallet or turnover mutations.
begin;
set local lock_timeout='5s';
do $$
declare source text; r record; delta numeric; owing numeric; repaid numeric; expected numeric;
begin
 for r in
  select 'order' kind,c.order_id::text id,c.user_id,c.points,c.paid_amount,c.rate from public.qiunai_membership_cashbacks c
  join public.play_orders p on p.id=c.order_id
  where c.reversed_at is null and p.paid and not coalesce(p.is_deleted,false)
   and p.status not in('cancelled','canceled','refunded','abandoned','已取消','已退款')
   and p.guild_id='1206138511535898654' and p.customer_id=c.user_id
  union all
  select 'extension',c.extension_id::text,c.user_id,c.points,c.paid_amount,c.rate from public.qiunai_membership_extension_cashbacks c
  join public.order_extensions e on e.id=c.extension_id join public.play_orders p on p.id=c.order_id
  where c.reversed_at is null and e.paid and p.paid and not coalesce(p.is_deleted,false)
   and e.status not in('cancelled','canceled','refunded','abandoned','已取消','已退款')
   and p.status not in('cancelled','canceled','refunded','abandoned','已取消','已退款')
   and p.guild_id='1206138511535898654' and e.customer_id=c.user_id and p.customer_id=c.user_id
  union all
  select 'topup',source_key,user_id,points,purchase_amount,rate from public.qiunai_membership_topup_rebates where reversed_at is null
  order by user_id,kind,id
 loop
  expected:=round(r.paid_amount*r.rate/100,2); delta:=expected-r.points;
  if delta<=0 then continue; end if;
  if delta>=1 then raise exception '回饋差額非取整缺口，停止：% %',r.kind,r.id; end if;
  source:=case when r.kind='topup' then 'membership-topup:precision:' else 'membership-cashback:precision:' end||r.kind||':'||r.id;
  perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||r.user_id,0));
  if exists(select 1 from public.qiunai_vip_point_logs where operation_key=source) then continue; end if;
  insert into public.qiunai_membership_point_debts(user_id) values(r.user_id) on conflict do nothing;
  select points into owing from public.qiunai_membership_point_debts where user_id=r.user_id for update;
  repaid:=least(delta,owing);
  update public.qiunai_membership_point_debts set points=points-repaid,updated_at=now() where user_id=r.user_id;
  insert into public.qiunai_vip_point_accounts(user_id,balance) values(r.user_id,delta-repaid)
   on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+excluded.balance,updated_at=now();
  insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
   values(r.user_id,source,delta-repaid,'回饋小數差額補發：'||r.paid_amount||' × '||r.rate||'% = '||expected||' 點；原 '||r.points||' 點，沖抵欠點 '||repaid);
  if r.kind='order' then
   update public.qiunai_membership_cashbacks set points=expected,debt_repaid=debt_repaid+repaid where order_id=r.id::uuid;
  elsif r.kind='extension' then
   update public.qiunai_membership_extension_cashbacks set points=expected,debt_repaid=debt_repaid+repaid where extension_id=r.id::bigint;
  else
   update public.qiunai_membership_topup_rebates set points=expected,debt_repaid=debt_repaid+repaid where source_key=r.id;
  end if;
 end loop;
end $$;
-- The helper validates payment, store, customer, activation, parent snapshot,
-- incremental amount and its unique ledger before any award.
select public.qiunai_award_extension_cashback(id) from public.order_extensions
 where guild_id='1206138511535898654' and paid and paid_at>='2026-10-15 16:44:27.918057+00' order by id;
commit;
