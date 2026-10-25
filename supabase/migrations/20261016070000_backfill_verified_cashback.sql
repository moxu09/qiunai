-- Explicitly authorized correction: ORD-0000001798 +2 and extension 282 +4 only.
-- No historical VIP rewards, no wallet/top-up mutation, no future automatic grants.
begin;
set local lock_timeout='5s';
create table if not exists public.qiunai_membership_extension_cashbacks(
 extension_id bigint primary key references public.order_extensions(id),
 order_id uuid not null references public.play_orders(id),user_id text not null,
 rate numeric not null,paid_amount numeric not null,points integer not null check(points>=0),
 reversed_at timestamptz,created_at timestamptz not null default now()
);
alter table public.qiunai_membership_extension_cashbacks enable row level security;
revoke all on public.qiunai_membership_extension_cashbacks from public,anon,authenticated;
grant all on public.qiunai_membership_extension_cashbacks to service_role;

create or replace function public.qiunai_reverse_extension_cashback(p_extension_id bigint)
returns void language plpgsql security definer set search_path=public as $$
declare r public.qiunai_membership_extension_cashbacks%rowtype; uid text; available integer; reclaimed integer;
begin
 select user_id into uid from public.qiunai_membership_extension_cashbacks where extension_id=p_extension_id;
 if not found then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||uid,0));
 select * into r from public.qiunai_membership_extension_cashbacks where extension_id=p_extension_id for update;
 if r.reversed_at is not null then return; end if;
 select balance into available from public.qiunai_vip_point_accounts where user_id=uid for update;
 reclaimed:=least(coalesce(available,0),r.points);
 update public.qiunai_vip_point_accounts set balance=balance-reclaimed,updated_at=now() where user_id=uid;
 insert into public.qiunai_membership_point_debts(user_id,points) values(uid,r.points-reclaimed)
 on conflict(user_id) do update set points=qiunai_membership_point_debts.points+excluded.points,updated_at=now();
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(uid,'membership-refund:extension:'||p_extension_id,-reclaimed,'加時退款：沖回補發消費點數；不足部分列退單欠點');
 update public.qiunai_membership_extension_cashbacks set reversed_at=now() where extension_id=p_extension_id;
end $$;
revoke all on function public.qiunai_reverse_extension_cashback(bigint) from public,anon,authenticated;
grant execute on function public.qiunai_reverse_extension_cashback(bigint) to service_role;

create or replace function public.qiunai_reverse_granted_extension_cashback()
returns trigger language plpgsql security definer set search_path=public as $$
declare eid bigint;
begin
 if new.guild_id is distinct from '1206138511535898654' then return new; end if;
 if tg_table_name='order_extensions' then
  if not coalesce(new.paid,false) or new.status in('cancelled','canceled','refunded','abandoned','已取消','已退款') then
   perform public.qiunai_reverse_extension_cashback(new.id);
  end if;
 else
  if not coalesce(new.paid,false) or coalesce(new.is_deleted,false)
  or new.status in('cancelled','canceled','refunded','abandoned','已取消','已退款') then
   for eid in select extension_id from public.qiunai_membership_extension_cashbacks where order_id=new.id and reversed_at is null order by extension_id loop
    perform public.qiunai_reverse_extension_cashback(eid);
   end loop;
  end if;
 end if;
 return new;
end $$;
revoke all on function public.qiunai_reverse_granted_extension_cashback() from public,anon,authenticated;
drop trigger if exists qiunai_reverse_granted_extension_cashback on public.order_extensions;
create trigger qiunai_reverse_granted_extension_cashback after update of paid,status on public.order_extensions
for each row execute function public.qiunai_reverse_granted_extension_cashback();
drop trigger if exists qiunai_reverse_child_extension_cashback on public.play_orders;
create trigger qiunai_reverse_child_extension_cashback after update of paid,status,is_deleted on public.play_orders
for each row execute function public.qiunai_reverse_granted_extension_cashback();

do $$
declare o public.play_orders%rowtype; parent public.play_orders%rowtype;
 e public.order_extensions%rowtype; r public.qiunai_membership_cashbacks%rowtype;
 x public.qiunai_membership_extension_cashbacks%rowtype; v integer;
begin
 select * into o from public.play_orders where id='c06b8543-eb93-4955-81d6-6cac311f291f' for update;
 if not found or o.guild_id<>'1206138511535898654' or o.customer_id<>'415392271136194561'
 or not coalesce(o.paid,false) or o.status<>'completed' or coalesce(o.is_deleted,false)
 or coalesce(o.final_price,o.price)<>280 or o.paid_at::timestamp<>'2026-10-15 16:03:47.448969'::timestamp then
  raise exception '280 元主單資料已變更，停止補發'; end if;
 select * into parent from public.play_orders where id='2cf3f767-37c3-47f1-ad7b-aee0feda248e' for update;
 if not found or parent.guild_id<>'1206138511535898654' or parent.customer_id<>'1310842435672211456'
 or not coalesce(parent.paid,false) or parent.status<>'completed' or coalesce(parent.is_deleted,false)
 or coalesce(parent.final_price,parent.price)<>582 then raise exception '加時主單資料已變更，停止補發'; end if;
 select * into e from public.order_extensions where id=282 for update;
 if not found or e.order_id::text is distinct from parent.id::text or e.guild_id<>'1206138511535898654' or e.customer_id<>parent.customer_id
 or not coalesce(e.paid,false) or e.status<>'paid' or e.amount<>240 then raise exception '240 元加時資料已變更，停止補發'; end if;
 -- Same point-lock keys as live checkouts; additive updates never overwrite concurrent spending.
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:1310842435672211456',0));
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:415392271136194561',0));
 if exists(select 1 from public.qiunai_membership_point_debts where user_id in(o.customer_id,e.customer_id) and points<>0)
 then raise exception '存在退單欠點，須重新核對，未補發'; end if;
 select * into r from public.qiunai_membership_cashbacks where order_id=o.id for update;
 if found then
  if r.user_id<>o.customer_id or r.points<>2 or r.rate<>1 or r.paid_amount<>280
  or not exists(select 1 from public.qiunai_vip_point_logs where operation_key='membership-cashback:'||o.id and user_id=o.customer_id and amount=2)
  then raise exception '主單已有不同回饋紀錄，停止重發'; end if;
 else
  if exists(select 1 from public.qiunai_vip_point_logs where operation_key='membership-cashback:'||o.id) then raise exception '主單已有點數流水但缺少來源紀錄，停止'; end if;
  insert into public.qiunai_membership_cashbacks(order_id,user_id,level_key,rate,paid_amount,points,debt_repaid)
  values(o.id,o.customer_id,'vip2',1,280,2,0);
  insert into public.qiunai_vip_point_accounts(user_id,balance) values(o.customer_id,2)
  on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+2,updated_at=now();
  insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
  values(o.customer_id,'membership-cashback:'||o.id,2,'ORD-0000001798 消費回饋補發：280 元 × 1%；10/16 00:00 起回溯上線缺口');
 end if;
 select * into x from public.qiunai_membership_extension_cashbacks where extension_id=e.id for update;
 if found then
  if x.user_id<>e.customer_id or x.points<>4 or x.rate<>2 or x.paid_amount<>240
  or not exists(select 1 from public.qiunai_vip_point_logs where operation_key='membership-cashback:extension:282' and user_id=e.customer_id and amount=4)
  then raise exception '加時已有不同回饋紀錄，停止重發'; end if;
 else
  if exists(select 1 from public.qiunai_vip_point_logs where operation_key='membership-cashback:extension:282') then raise exception '加時已有點數流水但缺少來源紀錄，停止'; end if;
  if not exists(select 1 from public.qiunai_membership_cashbacks where order_id=parent.id and user_id=e.customer_id and rate=2 and paid_amount=342 and points=6 and reversed_at is null)
  then raise exception '主單回饋基準已變更，停止加時補發'; end if;
  insert into public.qiunai_membership_extension_cashbacks(extension_id,order_id,user_id,rate,paid_amount,points)
  values(e.id,parent.id,e.customer_id,2,240,4);
  insert into public.qiunai_vip_point_accounts(user_id,balance) values(e.customer_id,4)
  on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+4,updated_at=now();
  insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
  values(e.customer_id,'membership-cashback:extension:282',4,'ORD-0000001801 加時 #282 回饋補發：240 元 × 2%，取整數 4 點；不重發原主單 6 點');
 end if;
end $$;
commit;
