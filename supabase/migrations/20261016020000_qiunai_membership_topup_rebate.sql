begin;
create table if not exists public.qiunai_membership_rebate_plans (
 user_id text not null, billing_month date not null, plan text not null check(plan in('monthly','weekly')),
 updated_at timestamptz not null default now(),primary key(user_id,billing_month)
);
create table if not exists public.qiunai_membership_topup_rebates (
 source_key text primary key,user_id text not null,confirmed_at timestamptz not null,
 billing_month date not null,period_key text not null,plan text not null,rate integer not null,
 purchase_amount numeric not null,points integer not null,debt_repaid integer not null default 0,
 reversed_at timestamptz,unique(user_id,period_key)
);
alter table public.qiunai_membership_rebate_plans enable row level security;
alter table public.qiunai_membership_topup_rebates enable row level security;
revoke all on public.qiunai_membership_rebate_plans,public.qiunai_membership_topup_rebates from public,anon,authenticated;
grant all on public.qiunai_membership_rebate_plans,public.qiunai_membership_topup_rebates to service_role;

create or replace function public.qiunai_set_membership_rebate_plan(p_user_id text,p_plan text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare month_start date:=date_trunc('month',now() at time zone 'Asia/Taipei')::date; selected_sort integer;
begin
 if coalesce(p_user_id,'')='' or p_plan not in('monthly','weekly') or p_plan is null then raise exception '首充返利方案無效'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||p_user_id,0));
 select l.sort_order into selected_sort from public.user_vips v join public.vip_levels l
 on l.guild_id=v.guild_id and l.level_key=v.level_key where v.user_id=p_user_id and v.guild_id='1206138511535898654';
 if coalesce(selected_sort,0)<7 or (p_plan='weekly' and selected_sort<9) then raise exception '目前會員級別尚未開放此方案'; end if;
 if exists(select 1 from public.qiunai_membership_topup_rebates where user_id=p_user_id and billing_month=month_start) then
   if exists(select 1 from public.qiunai_membership_topup_rebates where user_id=p_user_id and billing_month=month_start and plan<>p_plan) then raise exception '本月已使用首充返利，次月才能更換方案'; end if;
 end if;
 insert into public.qiunai_membership_rebate_plans(user_id,billing_month,plan) values(p_user_id,month_start,p_plan)
 on conflict(user_id,billing_month) do update set plan=excluded.plan,updated_at=now();
 return jsonb_build_object('plan',p_plan,'billing_month',month_start);
end $$;
revoke all on function public.qiunai_set_membership_rebate_plan(text,text) from public,anon,authenticated;
grant execute on function public.qiunai_set_membership_rebate_plan(text,text) to service_role;

create or replace function public.qiunai_membership_topup_rebate()
returns trigger language plpgsql security definer set search_path=public as $$
declare row_data jsonb:=to_jsonb(new); uid text; source text; paid_time timestamptz; activated timestamptz;
 purchase numeric; month_start date; start_time timestamptz; period text; selected_plan text; selected_sort integer;
 rate integer; award integer; debt integer; repaid integer; balance_now integer; reclaimed integer;
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
 award:=floor(purchase*rate/100)::integer;
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
revoke all on function public.qiunai_membership_topup_rebate() from public,anon,authenticated;
drop trigger if exists qiunai_membership_topup_rebate on public.ecpay_service_payments;
create trigger qiunai_membership_topup_rebate after insert or update of status on public.ecpay_service_payments
for each row execute function public.qiunai_membership_topup_rebate();
drop trigger if exists qiunai_membership_topup_rebate on public.jkopay_topup_orders;
create trigger qiunai_membership_topup_rebate after insert or update of status on public.jkopay_topup_orders
for each row execute function public.qiunai_membership_topup_rebate();
drop trigger if exists qiunai_membership_topup_rebate on public.bot_manual_topups;
create trigger qiunai_membership_topup_rebate after insert or update of status on public.bot_manual_topups
for each row execute function public.qiunai_membership_topup_rebate();
commit;
