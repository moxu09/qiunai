-- Reduce unauthenticated access without changing signed-in client or backend privileges.
-- Employee/manager row policies are a separate rollout; keep existing authenticated access here.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $deny_anonymous_private_access$
declare t record; who text; p text; prior jsonb;
begin
 for t in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and not c.relrowsecurity order by c.relname
 loop
  prior:='{}'::jsonb;
  foreach who in array array['authenticated','service_role'] loop
   foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    prior:=prior||jsonb_build_object(who||':'||p,has_table_privilege(who,t.oid,p));
   end loop;
  end loop;
  if t.relname=any(array['shop_items','vip_levels','xy_shop_items','xy_vip_levels']) then
   -- Retain existing public price/VIP catalogs; remove all anonymous mutations.
   execute format('revoke insert,update,delete,truncate,references,trigger on table public.%I from public,anon',t.relname);
  else
   execute format('revoke all on table public.%I from public,anon',t.relname);
   if has_table_privilege('anon',t.oid,'SELECT') then raise exception 'Anonymous SELECT still allowed: %',t.relname; end if;
  end if;
  foreach p in array array['INSERT','UPDATE','DELETE','TRUNCATE'] loop
   if has_table_privilege('anon',t.oid,p) then raise exception 'Anonymous mutation still allowed: %.%',t.relname,p; end if;
  end loop;
  foreach who in array array['authenticated','service_role'] loop
   foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if has_table_privilege(who,t.oid,p) is distinct from (prior->>(who||':'||p))::boolean then
     raise exception 'Existing signed-in/backend privilege changed: %.%.%',t.relname,who,p;
    end if;
   end loop;
  end loop;
 end loop;
end $deny_anonymous_private_access$;
commit;
