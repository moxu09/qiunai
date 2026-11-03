-- Immutable salary-wallet entries: employees read their own rows; managers read their own shop.
-- All mutations remain backend-only. Do not alter balances or historical ledger rows.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table public.salary_wallet_entries enable row level security;
do $reset_ledger_policies$
declare p record;
begin
 for p in select polname from pg_policy where polrelid='public.salary_wallet_entries'::regclass loop
  execute format('drop policy %I on public.salary_wallet_entries',p.polname);
 end loop;
end $reset_ledger_policies$;
revoke all on public.salary_wallet_entries from public,anon;
revoke insert,update,delete,truncate,references,trigger on public.salary_wallet_entries from authenticated;
create policy salary_wallet_entries_select on public.salary_wallet_entries for select to authenticated using(
 discord_id=(select public.erp_current_discord_id())
 or (app_key='qiunai' and (select public.erp_is_manager('qiunai')))
 or (app_key='deepnight' and (select public.erp_is_manager('deepnight')))
 or (app_key='xy' and (select public.erp_is_manager('xy')))
);
do $verify_ledger_backend$
declare p text;
begin
 foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
  if not has_table_privilege('service_role','public.salary_wallet_entries',p) then raise exception 'Backend ledger access lost: %',p; end if;
 end loop;
 if has_table_privilege('authenticated','public.salary_wallet_entries','UPDATE') or has_table_privilege('anon','public.salary_wallet_entries','SELECT') then raise exception 'Direct wallet access still unsafe'; end if;
end $verify_ledger_backend$;
commit;
