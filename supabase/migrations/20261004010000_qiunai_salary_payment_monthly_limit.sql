-- Only employee spending, not manual penalties; retain settled bonus rows in the total.
create or replace function public.qiunai_guard_salary_payment_monthly_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  month_start timestamptz;
  month_end timestamptz;
  monthly_used numeric;
begin
  if coalesce(new.amount, 0) >= 0 or coalesce(new.note, '') not like '使用薪水%' then
    return new;
  end if;
  month_start := date_trunc('month', coalesce(new.created_at, now()) at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  month_end := ((month_start at time zone 'Asia/Taipei') + interval '1 month') at time zone 'Asia/Taipei';
  -- Same lock as the atomic order-payment RPC; legacy tip/extension INSERTs also participate.
  perform pg_advisory_xact_lock(hashtextextended('qiunai-salary-user:' || new.discord_id::text, 0));
  select coalesce(sum(-amount), 0) into monthly_used
    from public.qiunai_staff_bonus
    where discord_id = new.discord_id and amount < 0 and note like '使用薪水%'
      and created_at >= month_start and created_at < month_end
      and id is distinct from new.id;
  if monthly_used + abs(new.amount) > 30000 then
    raise exception '每月員工扣薪消費上限 NT$30,000；本月已使用 NT$%，剩餘 NT$%，請改用其他付款方式',
      monthly_used, greatest(0, 30000 - monthly_used);
  end if;
  return new;
end;
$$;

create or replace trigger qiunai_salary_payment_monthly_limit
before insert or update of amount, note, discord_id, created_at on public.qiunai_staff_bonus
for each row execute function public.qiunai_guard_salary_payment_monthly_limit();
