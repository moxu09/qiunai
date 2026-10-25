begin;
create table if not exists public.qiunai_manual_point_grants (
 operation_key text primary key, guild_id text not null,
 user_id text not null, actor_id text not null, channel_id text not null,
 requested_points numeric(20,2) not null check(requested_points>0),
 credited_points numeric(20,2) not null, debt_repaid numeric(20,2) not null,
 balance_after numeric(20,2) not null, reason text not null,
 created_at timestamptz not null default now()
);
alter table public.qiunai_manual_point_grants enable row level security;
revoke all on public.qiunai_manual_point_grants from public, anon, authenticated;
grant select,insert on public.qiunai_manual_point_grants to service_role;

create or replace function public.qiunai_grant_manual_points(
 p_operation_key text,p_guild_id text,p_user_id text,p_actor_id text,
 p_channel_id text,p_points numeric,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 r public.qiunai_manual_point_grants%rowtype;
 debt numeric; repaid numeric; credited numeric; balance_now numeric;
begin
 if p_guild_id is distinct from '1206138511535898654' then raise exception '此功能僅供秋奈使用'; end if;
 if p_user_id is null or p_user_id !~ '^[0-9]{17,20}$'
 or p_actor_id is null or p_actor_id !~ '^[0-9]{17,20}$'
 or p_channel_id is null or p_channel_id !~ '^[0-9]{17,20}$'
 or p_operation_key is null or p_operation_key !~ '^manual-cashback:[0-9]{17,20}$'
 then raise exception '發放識別資料不完整'; end if;
 if p_points is null or not(p_points>0 and p_points<=1000000)
 or p_points<>round(p_points,2) then raise exception '點數須為0.01至1000000，最多兩位小數'; end if;
 if p_reason is null or length(trim(p_reason)) not between 1 and 200 then raise exception '請填寫200字內的發放原因'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-points:'||p_user_id,0));
 -- Serialise retries even if a malformed request reuses a key for another user.
 perform pg_advisory_xact_lock(hashtextextended('manual-points:'||p_operation_key,0));
 select * into r from public.qiunai_manual_point_grants where operation_key=p_operation_key;
 if found then
   if r.guild_id<>p_guild_id or r.user_id<>p_user_id or r.actor_id<>p_actor_id
   or r.channel_id<>p_channel_id or r.requested_points<>p_points or r.reason<>trim(p_reason)
   then raise exception '同一發放編號不可更換資料'; end if;
   return to_jsonb(r)||jsonb_build_object('already_applied',true);
 end if;
 insert into public.qiunai_membership_point_debts(user_id) values(p_user_id) on conflict do nothing;
 select points into debt from public.qiunai_membership_point_debts where user_id=p_user_id for update;
 repaid:=least(p_points,debt); credited:=p_points-repaid;
 update public.qiunai_membership_point_debts set points=points-repaid,updated_at=now() where user_id=p_user_id;
 insert into public.qiunai_vip_point_accounts(user_id,balance) values(p_user_id,credited)
 on conflict(user_id) do update set balance=qiunai_vip_point_accounts.balance+excluded.balance,updated_at=now()
 returning balance into balance_now;
 insert into public.qiunai_vip_point_logs(user_id,operation_key,amount,note)
 values(p_user_id,p_operation_key,credited,'人工回饋：'||trim(p_reason)||'｜發放 '||p_points||' 點；沖抵欠點 '||repaid||' 點｜操作人 '||p_actor_id||'｜頻道 '||p_channel_id);
 insert into public.qiunai_manual_point_grants(operation_key,guild_id,user_id,actor_id,channel_id,
 requested_points,credited_points,debt_repaid,balance_after,reason)
 values(p_operation_key,p_guild_id,p_user_id,p_actor_id,p_channel_id,p_points,credited,repaid,balance_now,trim(p_reason)) returning * into r;
 return to_jsonb(r)||jsonb_build_object('already_applied',false);
end;
$$;
revoke all on function public.qiunai_grant_manual_points(text,text,text,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.qiunai_grant_manual_points(text,text,text,text,text,numeric,text) to service_role;
notify pgrst,'reload schema';
commit;
