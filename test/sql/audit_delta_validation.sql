begin;
set local statement_timeout='30s';
savepoint audit_probe;
create temp table audit_delta_probe_20261102(id text,app_key text,price numeric,note text,payload text,updated_at timestamptz);
create trigger audit_delta_probe after insert or update or delete on audit_delta_probe_20261102 for each row execute function public.log_erp_activity('system');
do $audit_delta_checks$
declare marker text := 'compact-probe-'||gen_random_uuid()::text; r record; n int; expected bigint; start_id bigint;
begin
 select coalesce(max(id),0) into start_id from public.erp_activity_logs;
 insert into audit_delta_probe_20261102 values(marker,'qiunai',100,'old',repeat('unchanged payload',1000),now());
 select * into r from public.erp_activity_logs where id>start_id and table_name='audit_delta_probe_20261102' and record_id=marker and operation='INSERT' order by id desc limit 1;
 if r.new_data->>'payload' is distinct from repeat('unchanged payload',1000) then raise exception 'INSERT snapshot lost'; end if;
 update audit_delta_probe_20261102 set price=120,note=null,updated_at=now()+interval '1 second' where id=marker;
 select * into r from public.erp_activity_logs where id>start_id and table_name='audit_delta_probe_20261102' and record_id=marker and operation='UPDATE' order by id desc limit 1;
 if r.old_data->>'price'<>'100' or r.new_data->>'price'<>'120' or r.old_data->>'note'<>'old' or r.new_data->'note' is distinct from 'null'::jsonb or r.old_data?'payload' or r.new_data?'payload' or r.organization_code<>'qiunai' then raise exception 'UPDATE change/context lost'; end if;
 select count(*) into expected from public.erp_activity_logs where id>start_id and table_name='audit_delta_probe_20261102' and record_id=marker;
 update audit_delta_probe_20261102 set updated_at=now()+interval '2 seconds' where id=marker;
 select count(*) into n from public.erp_activity_logs where id>start_id and table_name='audit_delta_probe_20261102' and record_id=marker;
 if n<>expected then raise exception 'Timestamp-only update logged'; end if;
 delete from audit_delta_probe_20261102 where id=marker;
 select * into r from public.erp_activity_logs where id>start_id and table_name='audit_delta_probe_20261102' and record_id=marker and operation='DELETE' order by id desc limit 1;
 if r.old_data->>'payload' is distinct from repeat('unchanged payload',1000) or r.old_data->>'price'<>'120' then raise exception 'DELETE snapshot lost'; end if;
end $audit_delta_checks$;
rollback to savepoint audit_probe;
release savepoint audit_probe;
select 'passed' as audit_delta_checks,'INSERT and DELETE full; UPDATE exact changes; timestamp-only skipped; test rows rolled back' as coverage;
rollback;
