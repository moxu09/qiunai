-- Caller-supplied identity/payment parameters are authorized by server routes.
-- These SECURITY DEFINER helpers must not be callable directly by browsers.
-- Preserve existing backend grants, routine body, owner, and configuration.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $backend_rpc_only$
declare target record; routine regprocedure; prior record;
begin
  for target in select * from (values
    ('public.platform_credit_wallet_for_payment(uuid,jsonb)','92e53deae2bffe78020802508afee025'),
    ('public.alliance_recalculate_tier(text)','eebd0df766774713a1382606de27a32a'),
    ('public.alliance_review_redemption(uuid,boolean,uuid,text)','2c22e00562fd181b0e5e8c71d34bccea'),
    ('public.alliance_adjust_points(text,text,numeric,text,uuid)','b27ea01c95c13aded4d4314aed7820f6'),
    ('public.alliance_respond_exclusive_invitation(text,uuid,boolean)','facf7049f6c337b05b86fd9b3f93ac7e'),
    ('public.alliance_request_redemption(text,uuid,bigint,text)','208c9634b03982e8cead290b37a7a412'),
    ('public.transfer_salary_to_asd_atomic(text,text,text,integer,date,timestamp with time zone)','0b8b05a1a191599efe7bb9000c004f16'),
    ('public.alliance_apply_activity(text,text,text,numeric,text,text)','354c73b4e37392460f8455b341438dcd')
  ) as targets(signature,expected_hash) loop
    routine:=to_regprocedure(target.signature);
    if routine is null then raise exception 'Missing RPC: %',target.signature; end if;
    select md5(prosrc) as body_hash,proowner,prosecdef,proconfig into prior
      from pg_proc where oid=routine;
    if prior.body_hash <> target.expected_hash or not prior.prosecdef
       or pg_get_userbyid(prior.proowner)<>'postgres' then
      raise exception 'RPC definition/owner changed: %',target.signature;
    end if;
    if not has_function_privilege('service_role',routine,'EXECUTE') then
      raise exception 'Backend RPC access missing: %',target.signature;
    end if;
    execute format('revoke all on function %s from public,anon,authenticated',routine);
    if has_function_privilege('anon',routine,'EXECUTE')
       or has_function_privilege('authenticated',routine,'EXECUTE')
       or not has_function_privilege('service_role',routine,'EXECUTE') then
      raise exception 'RPC authorization invariant failed: %',target.signature;
    end if;
    if exists(select 1 from pg_proc p where p.oid=routine and (
      md5(p.prosrc)<>prior.body_hash or p.proowner<>prior.proowner
      or p.prosecdef is distinct from prior.prosecdef
      or p.proconfig is distinct from prior.proconfig)) then
      raise exception 'RPC definition changed: %',target.signature;
    end if;
  end loop;
end;
$backend_rpc_only$;
commit;
