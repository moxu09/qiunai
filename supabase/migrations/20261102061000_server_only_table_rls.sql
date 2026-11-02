-- Only tables already used via authenticated backend routes; no financial rows are changed.
-- Preserve service_role privileges and all history; remove raw browser access atomically.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $secure_backend_tables$
declare t text; p text; r regclass;
begin
 for t in select unnest(array[
    'salary_withdraw_requests',
    'accounting_ledger',
    'erp_activity_logs',
    'salary_requests',
    'salary_announcements',
    'salary_announcement_signatures',
    'employment_contract_signings',
    'device_audit_reports',
    'device_audit_upload_tokens',
    'device_audit_role_memberships',
    'customer_service_order_points',
    'salary_public_profiles',
    'salary_wallet_correction_operations',
    'erp_role_assignments',
    'monthly_accounts',
    'monthly_account_transactions',
    'member_monthly_accounts',
    'member_monthly_bills',
    'member_monthly_transactions',
    'jkopay_topups',
    'jkopay_topup_orders',
    'jkopay_service_payments',
    'alliance_members',
    'transfers',
    'bot_service_order_flows',
    'order_extensions',
    'order_reviews',
    'merchandise_orders',
    'salary_orders',
    'member_guarantee_logs',
    'raffle_spending',
    'red_packet_claims',
    'used_coupons',
    'user_benefits',
    'user_vips',
    'monthly_vips',
    'vip_monthly_keep_logs',
    'vip_upgrade_logs'
 ]) loop
  r:=to_regclass('public.'||t);
  if r is null then continue; end if;
  foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
   if not has_table_privilege('service_role',r,p) then raise exception 'Backend privilege missing before hardening: %.%',t,p; end if;
  end loop;
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public,anon,authenticated',t);
  if has_table_privilege('anon',r,'SELECT') or has_table_privilege('anon',r,'UPDATE') or has_table_privilege('authenticated',r,'SELECT') or has_table_privilege('authenticated',r,'UPDATE') then raise exception 'Browser privilege still present: %',t; end if;
  foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
   if not has_table_privilege('service_role',r,p) then raise exception 'Backend privilege changed: %.%',t,p; end if;
  end loop;
 end loop;
end $secure_backend_tables$;
commit;
