begin;
set local statement_timeout='30s';
create temp table eip_probe_accounts(uid uuid, discord_id text, org text, kind text) on commit drop;
insert into eip_probe_accounts
select distinct on (org) uid,discord_id,org,'employee' from (
 select i.user_id uid,coalesce(i.identity_data->>'provider_id',i.identity_data->>'sub') discord_id,s.org
 from auth.identities i join (
  select discord_id,'qiunai' org from public.qiunai_staff
  union all select discord_id,'deepnight' org from public.players
 ) s on s.discord_id=coalesce(i.identity_data->>'provider_id',i.identity_data->>'sub')
 where i.provider='discord' and s.discord_id<>'847840193859682304'
 and not exists(select 1 from public.erp_role_assignments a where a.discord_id=s.discord_id and a.is_active and a.role in('super_admin','store_manager','customer_service'))
 and not exists(select 1 from public.admins a where a.discord_id=s.discord_id and a.is_active)
 and not exists(select 1 from public.qiunai_admins a where a.discord_id=s.discord_id and a.is_active)
) x order by org,uid;
insert into eip_probe_accounts
select user_id,coalesce(identity_data->>'provider_id',identity_data->>'sub'),'qiunai','owner'
from auth.identities where provider='discord' and coalesce(identity_data->>'provider_id',identity_data->>'sub')='847840193859682304' limit 1;
insert into eip_probe_accounts values('00000000-0000-0000-0000-000000000001',null,'qiunai','outsider');
grant select on eip_probe_accounts to authenticated;
create temp table eip_probe_results(kind text,organization text,checks_passed int) on commit drop;
grant insert on eip_probe_results to authenticated;
do $validate_eip_scope$
declare r record; t text; n bigint; expected bigint; checks int; actual text; expected_staff bigint; expected_orders bigint;
begin
 if (select count(*) from eip_probe_accounts where kind='employee')<>2 then raise exception 'Need real employee identities for both shops'; end if;
 if not exists(select 1 from eip_probe_accounts where kind='owner') then raise exception 'Need existing owner identity'; end if;
 for r in select * from eip_probe_accounts loop
  checks:=0;
  if r.org='qiunai' then
   select count(*) into expected_staff from public.qiunai_staff where discord_id=r.discord_id;
   select count(*) into expected_orders from public.qiunai_salary_orders where discord_id=r.discord_id;
  else
   select count(*) into expected_staff from public.players where discord_id=r.discord_id;
   select count(*) into expected_orders from public.play_orders where discord_id=r.discord_id and (guild_id='1501098191813214312' or guild_id is null);
  end if;
  perform set_config('request.jwt.claim.sub',r.uid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',r.uid,'role','authenticated','user_metadata',jsonb_build_object('provider_id','847840193859682304'))::text,true);
  execute 'set local role authenticated';
  actual:=public.erp_current_discord_id();
  if actual is distinct from r.discord_id then raise exception 'Provider identity check failed for %',r.kind; end if;
  checks:=checks+1;
  if r.kind in ('employee','outsider') then
   if public.erp_is_manager('qiunai') or public.erp_is_manager('deepnight') or public.erp_has_salary_access('qiunai') or public.erp_has_salary_access('deepnight') then raise exception 'Unprivileged identity gained admin access'; end if;
   foreach t in array array['qiunai_staff','qiunai_staff_services','qiunai_salary_orders','qiunai_staff_bonus','qiunai_admins','players','players_services','players_bonus','admins','play_orders','salary_wallet_entries'] loop
    execute format('select count(*) from public.%I where discord_id is distinct from $1',t) into n using actual;
    if n<>0 then raise exception 'Cross-employee row leak: %',t; end if;
    checks:=checks+1;
   end loop;
   if r.kind='employee' then
    if r.org='qiunai' then
     select count(*) into n from public.qiunai_staff where discord_id=actual;
     if n<>expected_staff or n=0 then raise exception 'Own Qiunai profile missing'; end if;
     select count(*) into n from public.qiunai_salary_orders where discord_id=actual;
     if n<>expected_orders then raise exception 'Own Qiunai salary history incomplete'; end if;
    else
     select count(*) into n from public.players where discord_id=actual;
     if n<>expected_staff or n=0 then raise exception 'Own DeepNight profile missing'; end if;
     select count(*) into n from public.play_orders where discord_id=actual;
     if n<>expected_orders then raise exception 'Own DeepNight salary history incomplete'; end if;
    end if;
    checks:=checks+2;
   end if;
   -- An employee cannot alter even their own financial/profile/role rows.
   foreach t in array array['qiunai_staff','qiunai_salary_orders','qiunai_staff_bonus','players','players_bonus','play_orders'] loop
    execute format('with u as (update public.%I set discord_id=discord_id where discord_id=$1 returning 1) select count(*) from u',t) into n using actual;
    if n<>0 then raise exception 'Employee financial/profile mutation allowed: %',t; end if;
    checks:=checks+1;
   end loop;
  else
   if not public.erp_is_manager('qiunai') or not public.erp_is_manager('deepnight') then raise exception 'Owner access lost'; end if;
   checks:=checks+1;
   select count(*) into n from public.qiunai_staff;
   execute 'reset role';
   select count(*) into expected from public.qiunai_staff;
   if n<>expected then raise exception 'Owner staff listing incomplete'; end if;
   execute 'set local role authenticated';
   checks:=checks+1;
  end if;
  insert into eip_probe_results values(r.kind,r.org,checks);
  execute 'reset role';
 end loop;
end $validate_eip_scope$;
select * from eip_probe_results order by kind,organization;

rollback;
