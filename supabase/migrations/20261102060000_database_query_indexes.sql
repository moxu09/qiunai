-- Apply each CREATE INDEX CONCURRENTLY as its own statement, outside a transaction.
-- Matches the measured receipt recovery query; excludes closed workflows.
create index concurrently if not exists idx_bot_flows_open_org_updated
 on public.bot_service_order_flows (organization_code, updated_at) where closed_at is null;
-- Covers the measured monthly staff-salary lookup without indexing large JSON payloads.
create index concurrently if not exists idx_qiunai_salary_active_staff_finished
 on public.qiunai_salary_orders (discord_id, order_finished_at desc) include (staff_salary)
 where is_deleted = false or is_deleted is null;
