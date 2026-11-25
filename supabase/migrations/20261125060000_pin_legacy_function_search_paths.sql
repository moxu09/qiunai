-- Pin the existing legacy routines to trusted schemas. No body/ACL/RLS/data changes.
-- Preflight aborts on unexpected code or existing configuration; reruns are allowed.
-- pg_temp is explicit and last to prevent temporary objects shadowing public tables.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $pin_legacy_paths$
declare
  target record;
  routine regprocedure;
  prior record;
  trusted_path constant text := 'search_path=pg_catalog, public, pg_temp';
begin
  if has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'public is writable by a browser role; refusing unsafe search_path';
  end if;
  for target in select * from (values
    ('public.buy_shop_item(text,bigint)', '9e1c5cd8e1d70585fff8e9b11681f52f'),
    ('public.change_user_coins(text,numeric)', '6bb3d5a902492f185ae5b8df8b52583b'),
    ('public.change_xy_user_coins(text,numeric)', 'fd020a1321367d8e8243327b9bced321'),
    ('public.claim_red_packet_safe(bigint,text)', '247ed4966685884c88c082f628e27937'),
    ('public.claim_xy_red_packet_safe(bigint,text)', 'eb08c93171b2c66be88f00a75bd0379b'),
    ('public.get_user_rank(text)', 'aacb7379eb97a93ebf2c27f97dc325a7'),
    ('public.perform_gacha(text,integer,integer,jsonb)', '9d5ffb38d739d588433f7facd5049313'),
    ('public.update_updated_at()', '9b1889f56258bf9d6554213c05019c76')
  ) as targets(signature, expected_hash) loop
    routine := to_regprocedure(target.signature);
    if routine is null then raise exception 'Missing routine: %', target.signature; end if;
    select md5(prosrc) as body_hash, proacl, prosecdef, proowner, proconfig
      into prior from pg_proc where oid = routine;
    if prior.body_hash <> target.expected_hash then
      raise exception 'Routine body changed: %', target.signature;
    end if;
    if prior.proconfig is not null and prior.proconfig <> array[trusted_path] then
      raise exception 'Unexpected routine configuration: %', target.signature;
    end if;
    execute format('alter function %s set search_path = pg_catalog, public, pg_temp', routine);
    if exists (select 1 from pg_proc p where p.oid = routine and (
       md5(p.prosrc) <> prior.body_hash
       or p.proacl is distinct from prior.proacl
       or p.prosecdef is distinct from prior.prosecdef
       or p.proowner is distinct from prior.proowner
       or p.proconfig is distinct from array[trusted_path])) then
      raise exception 'Routine invariant failed: %', target.signature;
    end if;
  end loop;
end;
$pin_legacy_paths$;
commit;
