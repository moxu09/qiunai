-- 使用者確認撤回本代理於 2026-10-16 01:03–01:11（台灣）誤補之批次。
-- 精準比對 102 級次 / 95 會員 / 122 張券。封存後撤回；不改累積、錢包、有效領獎或月初私訊。
begin;
create table if not exists public.qiunai_membership_backfill_rollback (
 batch_id text primary key, payload jsonb not null, db_completed_at timestamptz,
 discord_completed_at timestamptz, created_at timestamptz not null default now()
);
alter table public.qiunai_membership_backfill_rollback enable row level security;
revoke all on public.qiunai_membership_backfill_rollback from public,anon,authenticated;
grant all on public.qiunai_membership_backfill_rollback to service_role;
do $$
declare snapshot jsonb; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('qiunai-revert-mistaken-backfill-20261016',0));
 if exists(select 1 from public.qiunai_membership_backfill_rollback where batch_id='mistaken-backfill-20261016' and db_completed_at is not null) then return; end if;
 create temp table rollback_keys on commit drop as
 select o.guild_id,o.user_id,o.level_key,o.created_at,o.role_id,o.reward_note
 from public.bot_vip_reward_operations o
 join public.qiunai_membership_ticket_grants t using(guild_id,user_id,level_key)
 join public.qiunai_membership_upgrade_entitlements e using(guild_id,user_id,level_key)
 where o.guild_id='1206138511535898654' and o.organization_code='qiunai'
 and o.created_at>='2026-10-15 17:03:40+00' and o.created_at<'2026-10-15 17:11:10+00'
 and t.created_at>='2026-10-15 17:03:40+00' and t.created_at<'2026-10-15 17:11:10+00'
 and e.created_at>='2026-10-15 17:03:40+00' and e.created_at<'2026-10-15 17:11:10+00'
 and o.reward_asd=0 and o.reward_points=0 and o.delivery_status='completed' and e.status='pending';
 if (select count(*) from rollback_keys)<>102 or (select count(distinct user_id) from rollback_keys)<>95 then raise exception '撤回批次級次或會員數不符，已停止'; end if;
 perform 1 from public.user_vips v where (v.guild_id,v.user_id) in(select guild_id,user_id from rollback_keys) order by v.user_id for update;
 create temp table rollback_members on commit drop as
 select distinct on(v.user_id) v.guild_id,v.user_id,v.level_key as expected_level_key,
 b.previous_state->>'level_key' as original_level_key,b.previous_state->>'level_name' as original_level_name,
 to_jsonb(v) as current_state,b.previous_state
 from public.user_vips v join rollback_keys k using(guild_id,user_id)
 join public.qiunai_membership_grandfather_20261016 b using(guild_id,user_id)
 join public.vip_levels l on l.guild_id=k.guild_id and l.level_key=k.level_key
 order by v.user_id,l.sort_order desc;
 if (select count(*) from rollback_members)<>95 then raise exception '缺少原等級備份，已停止'; end if;
 if exists(select 1 from rollback_members m where not exists(select 1 from rollback_keys k where k.user_id=m.user_id and k.guild_id=m.guild_id and k.level_key=m.expected_level_key)) then raise exception '會員等級已有其他變動，已停止'; end if;
 if exists(select 1 from public.vip_upgrade_logs l join rollback_members m using(guild_id,user_id) where l.created_at>='2026-10-15 17:11:10+00') then raise exception '批次後有有效升級，須另行保留，已停止'; end if;
 create temp table rollback_items on commit drop as
 select i.* from public.user_items i join rollback_keys k on k.guild_id=i.guild_id and k.user_id=i.user_id
 and i.description='會員升級福利｜'||k.level_key||'｜請聯繫客服核銷兌用；不會自動抽獎或扣款'
 where i.item_type='ticket' and i.created_at>='2026-10-15 17:03:40+00' and i.created_at<'2026-10-15 17:11:10+00';
 if (select count(*) from rollback_items)<>122 then raise exception '券已使用或張數不符，已停止'; end if;
 if (select count(*) from public.vip_upgrade_logs l join rollback_keys k on k.guild_id=l.guild_id and k.user_id=l.user_id and k.level_key=l.new_level_key
 where l.created_at>='2026-10-15 17:03:40+00' and l.created_at<'2026-10-15 17:11:10+00' and l.reward_asd=0 and l.reward_points=0)<>102 then raise exception '領獎紀錄不符，已停止'; end if;
 select jsonb_build_object(
 'members',(select jsonb_agg(to_jsonb(m)) from rollback_members m),
 'keys',(select jsonb_agg(to_jsonb(k)) from rollback_keys k),
 'items',(select jsonb_agg(to_jsonb(i)) from rollback_items i),
 'operations',(select jsonb_agg(to_jsonb(o)) from public.bot_vip_reward_operations o join rollback_keys k using(guild_id,user_id,level_key)),
 'entitlements',(select jsonb_agg(to_jsonb(e)) from public.qiunai_membership_upgrade_entitlements e join rollback_keys k using(guild_id,user_id,level_key)),
 'ticket_grants',(select jsonb_agg(to_jsonb(t)) from public.qiunai_membership_ticket_grants t join rollback_keys k using(guild_id,user_id,level_key)),
 'deliveries',(select jsonb_agg(to_jsonb(d)) from public.qiunai_vip_channel_deliveries d join rollback_keys k using(guild_id,user_id,level_key)),
 'upgrade_logs',(select jsonb_agg(to_jsonb(l)) from public.vip_upgrade_logs l join rollback_keys k on k.guild_id=l.guild_id and k.user_id=l.user_id and k.level_key=l.new_level_key where l.created_at>='2026-10-15 17:03:40+00' and l.created_at<'2026-10-15 17:11:10+00'),
 'point_logs',(select jsonb_agg(to_jsonb(p)) from public.qiunai_vip_point_logs p join rollback_keys k on p.user_id=k.user_id and p.operation_key='reward:'||k.user_id||':'||k.level_key where p.created_at>='2026-10-15 17:03:40+00' and p.created_at<'2026-10-15 17:11:10+00' and p.amount=0)
 ) into snapshot;
 insert into public.qiunai_membership_backfill_rollback(batch_id,payload) values('mistaken-backfill-20261016',snapshot);
 update public.user_vips v set level_key=m.original_level_key,level_name=m.original_level_name
 from rollback_members m where v.guild_id=m.guild_id and v.user_id=m.user_id and v.level_key=m.expected_level_key;
 get diagnostics n=row_count;
 if n<>95 then raise exception '等級恢復數不符，整批回復'; end if;
 delete from public.user_items i using rollback_items r where i.id=r.id;
 delete from public.qiunai_membership_upgrade_entitlements e using rollback_keys k where e.guild_id=k.guild_id and e.user_id=k.user_id and e.level_key=k.level_key;
 delete from public.qiunai_membership_ticket_grants t using rollback_keys k where t.guild_id=k.guild_id and t.user_id=k.user_id and t.level_key=k.level_key;
 delete from public.qiunai_vip_channel_deliveries d using rollback_keys k where d.guild_id=k.guild_id and d.user_id=k.user_id and d.level_key=k.level_key;
 delete from public.vip_upgrade_logs l using rollback_keys k where l.guild_id=k.guild_id and l.user_id=k.user_id and l.new_level_key=k.level_key and l.created_at>='2026-10-15 17:03:40+00' and l.created_at<'2026-10-15 17:11:10+00' and l.reward_asd=0 and l.reward_points=0;
 delete from public.qiunai_vip_point_logs p using rollback_keys k where p.user_id=k.user_id and p.operation_key='reward:'||k.user_id||':'||k.level_key and p.created_at>='2026-10-15 17:03:40+00' and p.created_at<'2026-10-15 17:11:10+00' and p.amount=0;
 delete from public.bot_vip_reward_operations o using rollback_keys k where o.guild_id=k.guild_id and o.user_id=k.user_id and o.level_key=k.level_key and o.organization_code='qiunai';
 update public.qiunai_membership_backfill_rollback set db_completed_at=now() where batch_id='mistaken-backfill-20261016';
end $$;
commit;
