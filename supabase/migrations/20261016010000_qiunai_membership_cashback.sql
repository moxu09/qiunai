begin;
set local lock_timeout='5s';
create table if not exists public.qiunai_membership_cashbacks (
 order_id uuid primary key references public.play_orders(id), user_id text not null,
 level_key text, rate numeric not null, paid_amount numeric not null,
 points integer not null check(points>=0), debt_repaid integer not null default 0,
 reversed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.qiunai_membership_point_debts (
 user_id text primary key, points integer not null default 0 check(points>=0),
 updated_at timestamptz not null default now()
);
alter table public.qiunai_membership_cashbacks enable row level security;
alter table public.qiunai_membership_point_debts enable row level security;
revoke all on public.qiunai_membership_cashbacks,public.qiunai_membership_point_debts from public,anon,authenticated;
grant all on public.qiunai_membership_cashbacks,public.qiunai_membership_point_debts to service_role;

create or replace function public.qiunai_membership_order_cashback()
returns trigger language plpgsql security definer set search_path=public as $$
declare l public.vip_levels%rowtype; r public.qiunai_membership_cashbacks%rowtype;
 activated timestamptz; spend numeric; topup numeric; old_sort integer; selected_rate numeric;
 amount_paid numeric; award integer; current_balance integer; debt integer; repaid integer; reclaimed integer;
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
 award:=floor(amount_paid*selected_rate/100)::integer;
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
revoke all on function public.qiunai_membership_order_cashback() from public,anon,authenticated;
drop trigger if exists qiunai_membership_order_cashback on public.play_orders;
create trigger qiunai_membership_order_cashback after insert or update of paid,status on public.play_orders
for each row execute function public.qiunai_membership_order_cashback();
commit;
