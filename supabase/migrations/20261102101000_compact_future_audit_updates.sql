-- Preserve all existing history. New UPDATE logs store only changed fields; INSERT/DELETE keep full snapshots.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
CREATE OR REPLACE FUNCTION public.log_erp_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
 v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
 v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
 v_row jsonb := coalesce(v_new, v_old, '{}'::jsonb);
 v_org text := 'shared';
 v_category text := coalesce(nullif(tg_argv[0], ''), 'system');
 v_record_id text;
 v_actor_id text;
 v_label text;
 v_changed_keys text[];
begin
 if tg_table_name like 'qiunai_%' then
 v_org := 'qiunai';
 elsif tg_table_name in ('orders', 'play_orders', 'players', 'players_bonus', 'admins', 'salary_orders') then
 v_org := 'deepnight';
 end if;

 if v_row ? 'app_key' and v_row->>'app_key' in ('deepnight', 'qiunai') then
 v_org := v_row->>'app_key';
 elsif v_row ? 'organization_code' and v_row->>'organization_code' in ('deepnight', 'qiunai') then
 v_org := v_row->>'organization_code';
 end if;

 v_record_id := coalesce(
 v_row->>'order_no', v_row->>'order_id', v_row->>'id',
 v_row->>'user_id', v_row->>'discord_id'
 );
 v_actor_id := coalesce(
 v_row->>'edited_by', v_row->>'reviewed_by', v_row->>'approved_by',
 v_row->>'created_by', v_row->>'discord_id', v_row->>'user_id'
 );
 v_label := case tg_op
 when 'INSERT' then '新增'
 when 'UPDATE' then '更新'
 else '刪除'
 end;

 -- Skip updates that do not actually change row data.
 if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
 return new;
 end if;

 -- UI renders changed fields from old_data/new_data. Keep each changed key's
 -- exact before/after value, including JSON null; avoid copying unchanged payloads.
 if tg_op = 'UPDATE' then
  select array_agg(k) into v_changed_keys
  from jsonb_object_keys(v_old || v_new) as keys(k)
  where (v_old -> k) is distinct from (v_new -> k);
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_old
  from jsonb_each(v_old) where key=any(v_changed_keys);
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_new
  from jsonb_each(v_new) where key=any(v_changed_keys);
 end if;

 insert into public.erp_activity_logs (
 organization_code, category, table_name, record_id, operation,
 summary, actor_id, old_data, new_data
 ) values (
 v_org, v_category, tg_table_name, v_record_id, tg_op,
 v_label || ' ' || tg_table_name || coalesce(' #' || v_record_id, ''),
 v_actor_id, v_old, v_new
 );

 if tg_op = 'DELETE' then
 return old;
 end if;
 return new;
end;
$function$
;
commit;
