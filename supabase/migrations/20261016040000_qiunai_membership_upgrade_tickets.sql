begin;
create table if not exists public.qiunai_membership_ticket_grants (
 guild_id text not null,user_id text not null,level_key text not null,
 tickets jsonb not null,created_at timestamptz not null default now(),
 primary key(guild_id,user_id,level_key)
);
alter table public.qiunai_membership_ticket_grants enable row level security;
revoke all on public.qiunai_membership_ticket_grants from public,anon,authenticated;
grant all on public.qiunai_membership_ticket_grants to service_role;
create or replace function public.qiunai_issue_membership_upgrade_tickets(p_user_id text,p_level_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare details text; found_ticket text[]; ticket_name text; ticket_count integer;
 issued jsonb:='[]'::jsonb; previous jsonb; activation timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('qiunai-upgrade-ticket:'||p_user_id||':'||p_level_key,0));
 select tickets into previous from public.qiunai_membership_ticket_grants
 where guild_id='1206138511535898654' and user_id=p_user_id and level_key=p_level_key;
 if found then return jsonb_build_object('already_granted',true,'tickets',previous); end if;
 select activated_at into activation from public.qiunai_membership_policy_archive where version='20261016';
 select reward_note into details from public.bot_vip_reward_operations
 where organization_code='qiunai' and guild_id='1206138511535898654'
 and user_id=p_user_id and level_key=p_level_key and created_at>=activation;
 if not found then raise exception '找不到新制升級獎勵紀錄，不得重發舊制福利'; end if;
 for found_ticket in select regexp_matches(details,'(殺比死卡池抽獎[劵券]|限定卡池(抽)?獎[劵券]|秋奈一番賞抽獎[劵券])\s*\*([0-9]+)','g') loop
  ticket_name:=replace(found_ticket[1],'劵','券');
  if ticket_name='限定卡池獎券' then ticket_name:='限定卡池抽獎券'; end if;
  ticket_count:=found_ticket[3]::integer;
  if ticket_count not between 1 and 20 then raise exception '升級抽獎券數量無效'; end if;
  insert into public.user_items(user_id,item_name,rarity,description,item_type,guild_id)
  select p_user_id,ticket_name,null,'會員升級福利｜'||p_level_key||'｜請聯繫客服核銷兌用；不會自動抽獎或扣款','ticket','1206138511535898654'
  from generate_series(1,ticket_count);
  issued:=issued||jsonb_build_array(jsonb_build_object('name',ticket_name,'count',ticket_count));
 end loop;
 insert into public.qiunai_membership_ticket_grants(guild_id,user_id,level_key,tickets)
 values('1206138511535898654',p_user_id,p_level_key,issued);
 return jsonb_build_object('already_granted',false,'tickets',issued);
end $$;
revoke all on function public.qiunai_issue_membership_upgrade_tickets(text,text) from public,anon,authenticated;
grant execute on function public.qiunai_issue_membership_upgrade_tickets(text,text) to service_role;
commit;
