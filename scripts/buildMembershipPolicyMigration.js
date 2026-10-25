// Pure SQL generator. Does not connect to or modify a database.
const { MEMBERSHIP_LEVELS } = require("../config/qiunaiMembership20261016");
const quote = value => value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const rows = MEMBERSHIP_LEVELS.map(level => `(${[
  "1206138511535898654", level.levelKey, level.name, level.totalSpendRequired,
  level.singleTopupRequired || 0, level.roleId, level.sortOrder, level.description,
  level.cashbackPercent, level.multiPlayerBonusPercent, level.multiPlayerMinimum || 0,
  level.invitationOnly, "20261016",
].map(value => typeof value === "number" || typeof value === "boolean" ? String(value) : quote(value)).join(",")})`).join(",\n");
process.stdout.write(`begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Backups are append-only and service-role-only. Never overwrite prior activation data.
create table if not exists public.qiunai_membership_policy_archive (
  version text primary key, activated_at timestamptz not null default now(),
  old_levels jsonb not null, old_points_levels jsonb not null,
  old_reward_function text not null, source_channel_id text not null,
  benefits_automation_status text not null default 'pending'
);
alter table public.qiunai_membership_policy_archive enable row level security;
revoke all on public.qiunai_membership_policy_archive from public,anon,authenticated;
grant all on public.qiunai_membership_policy_archive to service_role;
insert into public.qiunai_membership_policy_archive(version,old_levels,old_points_levels,old_reward_function,source_channel_id)
select '20261016',
 (select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.vip_levels l where guild_id='1206138511535898654'),
 (select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.qiunai_vip_points_levels l),
 pg_get_functiondef('public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb)'::regprocedure),
 '1313770637587644507'
on conflict(version) do nothing;
create table if not exists public.qiunai_membership_grandfather_20261016 (
 guild_id text not null, user_id text not null, previous_state jsonb not null,
 captured_at timestamptz not null default now(), primary key(guild_id,user_id)
);
alter table public.qiunai_membership_grandfather_20261016 enable row level security;
revoke all on public.qiunai_membership_grandfather_20261016 from public,anon,authenticated;
grant all on public.qiunai_membership_grandfather_20261016 to service_role;
insert into public.qiunai_membership_grandfather_20261016(guild_id,user_id,previous_state)
select guild_id,user_id,to_jsonb(v) from public.user_vips v where guild_id='1206138511535898654'
on conflict(guild_id,user_id) do nothing;
alter table public.vip_levels add column if not exists membership_policy_version text;
alter table public.vip_levels add column if not exists invitation_only boolean not null default false;
insert into public.vip_levels(guild_id,level_key,level_name,total_spend_required,single_topup_required,
role_id,sort_order,reward_note,cashback_rate,multi_player_cashback_rate,multi_player_min_count,invitation_only,membership_policy_version)
values
${rows}
on conflict(guild_id,level_key) do update set
level_name=excluded.level_name,total_spend_required=excluded.total_spend_required,
single_topup_required=excluded.single_topup_required,role_id=excluded.role_id,sort_order=excluded.sort_order,
reward_note=excluded.reward_note,cashback_rate=excluded.cashback_rate,
multi_player_cashback_rate=excluded.multi_player_cashback_rate,multi_player_min_count=excluded.multi_player_min_count,
invitation_only=excluded.invitation_only,membership_policy_version=excluded.membership_policy_version;
-- New upgrades no longer grant obsolete lump-sum points or old coupons.
-- The original ASD values remain archived/in-place for explicitly authorized historical backfills.
update public.vip_levels set reward_coupon=null,monthly_keep_required=0
where guild_id='1206138511535898654' and membership_policy_version='20261016';
insert into public.qiunai_vip_points_levels(level_key,total_spend_required,single_topup_required,reward_points,effective_at)
select level_key,total_spend_required,single_topup_required,0,now() from public.vip_levels
where guild_id='1206138511535898654' and membership_policy_version='20261016'
on conflict(level_key) do update set total_spend_required=excluded.total_spend_required,
single_topup_required=excluded.single_topup_required,reward_points=0,effective_at=excluded.effective_at;
-- Renaming does not promote/demote members or rewrite any accumulation.
update public.user_vips v set level_name=l.level_name from public.vip_levels l
where v.guild_id=l.guild_id and v.level_key=l.level_key and v.guild_id='1206138511535898654';
notify pgrst,'reload schema';
commit;
select count(*) as membership_levels,
count(*) filter(where invitation_only) as invitation_only_levels,
(select count(*) from public.qiunai_membership_grandfather_20261016) as preserved_members
from public.vip_levels where guild_id='1206138511535898654' and membership_policy_version='20261016';
`);
