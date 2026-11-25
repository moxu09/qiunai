-- Read-only role checks. No real payments, salary transfers, or reward writes.
begin read only;
set local statement_timeout='15s';
do $verify_hardening$
declare t text; r regprocedure; privilege text; signature text;
begin
  foreach t in array array['users','xy_users','wallet_logs','xy_wallet_logs'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t)
        and relrowsecurity and not relforcerowsecurity) then
      raise exception 'Wallet RLS invariant failed: %',t;
    end if;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon','public.'||t,privilege)
         or has_table_privilege('authenticated','public.'||t,privilege) then
        raise exception 'Browser wallet privilege remains: %.%',t,privilege;
      end if;
    end loop;
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role','public.'||t,privilege) then
        raise exception 'Backend wallet privilege missing: %.%',t,privilege;
      end if;
    end loop;
  end loop;
  if not exists(select 1 from pg_policies where schemaname='public'
      and tablename='users' and policyname='nas_replication_wallet_users_read'
      and roles=array['nas_replication']::name[] and cmd='SELECT' and qual='true')
     or not has_table_privilege('nas_replication','public.users','SELECT') then
    raise exception 'NAS users mirror policy/grant missing';
  end if;
  foreach signature in array array[
    'public.platform_credit_wallet_for_payment(uuid,jsonb)',
    'public.alliance_recalculate_tier(text)',
    'public.alliance_review_redemption(uuid,boolean,uuid,text)',
    'public.alliance_adjust_points(text,text,numeric,text,uuid)',
    'public.alliance_respond_exclusive_invitation(text,uuid,boolean)',
    'public.alliance_request_redemption(text,uuid,bigint,text)',
    'public.transfer_salary_to_asd_atomic(text,text,text,integer,date,timestamp with time zone)',
    'public.alliance_apply_activity(text,text,text,numeric,text,text)'
  ] loop
    r:=to_regprocedure(signature);
    if r is null or has_function_privilege('anon',r,'EXECUTE')
       or has_function_privilege('authenticated',r,'EXECUTE')
       or not has_function_privilege('service_role',r,'EXECUTE')
       or not has_function_privilege('postgres',r,'EXECUTE') then
      raise exception 'Backend RPC role invariant failed: %',signature;
    end if;
  end loop;
  foreach signature in array array[
    'public.buy_shop_item(text,bigint)',
    'public.change_user_coins(text,numeric)',
    'public.change_xy_user_coins(text,numeric)',
    'public.claim_red_packet_safe(bigint,text)',
    'public.claim_xy_red_packet_safe(bigint,text)',
    'public.get_user_rank(text)',
    'public.perform_gacha(text,integer,integer,jsonb)',
    'public.update_updated_at()'
  ] loop
    r:=to_regprocedure(signature);
    if r is null or not exists(select 1 from pg_proc where oid=r
        and proconfig=array['search_path=pg_catalog, public, pg_temp']) then
      raise exception 'Function search_path invariant failed: %',signature;
    end if;
  end loop;
end;
$verify_hardening$;
set local role anon;
do $anon_rpc$
begin
  begin
    perform public.alliance_recalculate_tier(null);
    raise exception 'Anonymous backend RPC unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end;
$anon_rpc$;
reset role;
set local role authenticated;
do $browser_reads$
declare t text;
begin
  foreach t in array array['users','xy_users','wallet_logs','xy_wallet_logs'] loop
    begin
      execute format('select 1 from public.%I limit 0',t);
      raise exception 'Browser wallet read unexpectedly allowed: %',t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.alliance_recalculate_tier(null);
    raise exception 'Browser backend RPC unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end;
$browser_reads$;
reset role;
set local role service_role;
do $backend_reads$
declare t text;
begin
  foreach t in array array['users','xy_users','wallet_logs','xy_wallet_logs'] loop
    execute format('select 1 from public.%I limit 0',t);
  end loop;
  begin
    perform public.alliance_recalculate_tier(null);
    raise exception 'Expected missing-member guard';
  exception when raise_exception then
    if sqlerrm<>'找不到聯盟會員' then raise; end if;
  end;
end;
$backend_reads$;
select public.get_user_rank(null) is null as rank_null_read_only_check;
reset role;
select 'security_role_checks_passed' as verification;
rollback;
