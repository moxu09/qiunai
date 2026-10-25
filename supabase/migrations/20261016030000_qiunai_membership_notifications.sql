begin;
create table if not exists public.qiunai_vip_rebate_notifications (
 billing_month date not null, user_id text not null,
 status text not null default 'pending' check(status in('pending','sending','sent','blocked','failed','left')),
 attempt_count integer not null default 0, attempted_at timestamptz,
 dm_channel_id text, dm_message_id text, sent_at timestamptz, last_error text,
 primary key(billing_month,user_id)
);
create table if not exists public.qiunai_vip_channel_deliveries (
 guild_id text not null,user_id text not null,level_key text not null,
 channel_id text not null,message_id text not null,created_at timestamptz not null default now(),
 primary key(guild_id,user_id,level_key)
);
-- 客製／抽獎福利尚須人工履約，不以升級播報冒充已履約。
create table if not exists public.qiunai_membership_upgrade_entitlements (
 guild_id text not null,user_id text not null,level_key text not null,
 policy_version text not null default '20261016',benefits text not null,
 status text not null default 'pending' check(status in('pending','fulfilled')),
 created_at timestamptz not null default now(),fulfilled_at timestamptz,
 primary key(guild_id,user_id,level_key)
);
alter table public.qiunai_vip_rebate_notifications enable row level security;
alter table public.qiunai_vip_channel_deliveries enable row level security;
alter table public.qiunai_membership_upgrade_entitlements enable row level security;
revoke all on public.qiunai_vip_rebate_notifications,public.qiunai_vip_channel_deliveries,public.qiunai_membership_upgrade_entitlements from public,anon,authenticated;
grant all on public.qiunai_vip_rebate_notifications,public.qiunai_vip_channel_deliveries,public.qiunai_membership_upgrade_entitlements to service_role;
create or replace function public.qiunai_choose_membership_rebate_month(p_user_id text,p_billing_month date,p_plan text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if p_billing_month is distinct from date_trunc('month',now() at time zone 'Asia/Taipei')::date then
  raise exception '這則首充方案訊息已過期，請使用本月訊息或 /首充返利';
 end if;
 return public.qiunai_set_membership_rebate_plan(p_user_id,p_plan);
end $$;
revoke all on function public.qiunai_choose_membership_rebate_month(text,date,text) from public,anon,authenticated;
grant execute on function public.qiunai_choose_membership_rebate_month(text,date,text) to service_role;
commit;
