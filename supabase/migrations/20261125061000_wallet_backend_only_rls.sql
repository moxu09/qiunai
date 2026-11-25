-- Wallet operations use trusted backend clients. Browser roles must not directly
-- read or mutate balances/history. Preserve the existing NAS users mirror.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $wallet_preflight$
declare t text; p record;
begin
  if not exists (select 1 from pg_roles where rolname='service_role' and rolbypassrls) then
    raise exception 'Backend role must bypass RLS';
  end if;
  if not has_table_privilege('nas_replication','public.users','SELECT') then
    raise exception 'Expected NAS users mirror privilege is missing';
  end if;
  foreach t in array array['users','xy_users','wallet_logs','xy_wallet_logs'] loop
    if not has_table_privilege('service_role','public.'||t,'SELECT')
       or not has_table_privilege('service_role','public.'||t,'INSERT')
       or not has_table_privilege('service_role','public.'||t,'UPDATE')
       or not has_table_privilege('service_role','public.'||t,'DELETE') then
      raise exception 'Backend privilege missing: %',t;
    end if;
    for p in select * from pg_policies where schemaname='public' and tablename=t loop
      if not (p.cmd='SELECT' and p.roles=array['nas_replication']::name[]
          and p.qual='true' and p.with_check is null
          and ((t='wallet_logs' and p.policyname='nas_replication_read')
            or (t='users' and p.policyname='nas_replication_wallet_users_read'))) then
        raise exception 'Unexpected wallet policy: %.%',t,p.policyname;
      end if;
    end loop;
  end loop;
end;
$wallet_preflight$;
do $nas_read_policy$
begin
  if not exists(select 1 from pg_policies where schemaname='public'
      and tablename='users' and policyname='nas_replication_wallet_users_read') then
    create policy nas_replication_wallet_users_read on public.users
      for select to nas_replication using (true);
  end if;
end;
$nas_read_policy$;
do $secure_wallets$
declare t text; privilege text;
begin
  foreach t in array array['users','xy_users','wallet_logs','xy_wallet_logs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon','public.'||t,privilege)
         or has_table_privilege('authenticated','public.'||t,privilege) then
        raise exception 'Browser privilege remains: %.%',t,privilege;
      end if;
    end loop;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role','public.'||t,privilege) then
        raise exception 'Backend privilege changed: %.%',t,privilege;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('nas_replication','public.users','SELECT') then
    raise exception 'NAS users mirror privilege changed';
  end if;
end;
$secure_wallets$;
commit;
