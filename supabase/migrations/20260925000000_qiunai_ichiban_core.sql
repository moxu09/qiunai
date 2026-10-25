-- 秋奈一番賞：ASD 錢包、抽紙與獎品庫存在同一個 PostgreSQL 交易內完成。
-- 正式收款仍須由已驗證的金流 callback 建立付款單，再呼叫同一獎池流程。
create table if not exists public.qiunai_ichiban_prizes (
  id text primary key,
  tier text not null check (tier in ('S', 'A', 'B', 'C', 'D', 'E', 'F')),
  name text not null,
  initial_quantity integer not null check (initial_quantity > 0)
);

insert into public.qiunai_ichiban_prizes(id, tier, name, initial_quantity) values
('s-airpods','S','AirPods',1), ('s-nitro-year','S','Nitro 一年份',1),
('a-starbucks-1688','A','星巴克 1,688 元禮券',1), ('a-lelabo-perfume','A','LE LABO 淡香精',1),
('a-lelabo-hand','A','LE LABO 護手霜',1), ('a-asd-1500','A','1,500 ASD',1),
('a-nitro-basic-year','A','Nitro Basic 一年份',1),
('b-711-1000','B','7-ELEVEN 1,000 元禮券',2), ('b-lelabo-lip','B','LE LABO 護唇膏',2),
('b-asd-1300','B','1,300 ASD',2),
('c-711-500','C','7-ELEVEN 500 元禮券',3), ('c-ladym','C','LADY M 切片蛋糕禮券',3),
('c-starbucks-175','C','星巴克 175 元禮券',3), ('c-asd-800','C','800 ASD',3),
('d-711-300','D','7-ELEVEN 300 元禮券',5), ('d-starbucks-145','D','星巴克 145 元禮券',5),
('d-asd-500','D','500 ASD',5),
('e-711-100','E','7-ELEVEN 100 元禮券',20), ('e-711-50','E','7-ELEVEN 50 元禮券',20),
('e-asd-100','E','100 ASD',20),
('f-asd-80','F','80 ASD',100), ('f-asd-50','F','50 ASD',100),
('f-asd-30','F','30 ASD',100), ('f-asd-10','F','10 ASD',100)
on conflict (id) do nothing;

create table if not exists public.qiunai_ichiban_draws (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null,
  payment_provider text not null check (payment_provider in ('asd', 'ecpay', 'jkopay')),
  payment_reference text not null,
  paid_amount integer not null check (paid_amount = 300),
  prize_id text not null references public.qiunai_ichiban_prizes(id),
  ticket_no integer not null unique,
  is_last_one boolean not null default false,
  created_at timestamptz not null default now(),
  unique (payment_provider, payment_reference)
);

create index if not exists qiunai_ichiban_draws_user_idx
  on public.qiunai_ichiban_draws(discord_user_id, created_at desc);

create table if not exists public.qiunai_ichiban_tickets (
  ticket_no integer primary key,
  prize_id text not null references public.qiunai_ichiban_prizes(id),
  draw_id uuid unique references public.qiunai_ichiban_draws(id),
  drawn_at timestamptz
);

-- 500 張序號固定；中獎由交易內 random() 選出剩餘序號，而非由前端決定。
with expanded as (
  select p.id as prize_id, n
  from public.qiunai_ichiban_prizes p
  cross join lateral generate_series(1, p.initial_quantity) as n
), numbered as (
  select row_number() over (order by prize_id, n)::integer as ticket_no, prize_id
  from expanded
)
insert into public.qiunai_ichiban_tickets(ticket_no, prize_id)
select ticket_no, prize_id from numbered
on conflict (ticket_no) do nothing;

create table if not exists public.qiunai_ichiban_pool_mutex (
  id integer primary key check (id = 1)
);
insert into public.qiunai_ichiban_pool_mutex(id) values (1) on conflict do nothing;

alter table public.qiunai_ichiban_prizes enable row level security;
alter table public.qiunai_ichiban_tickets enable row level security;
alter table public.qiunai_ichiban_draws enable row level security;
alter table public.qiunai_ichiban_pool_mutex enable row level security;

create or replace function public.qiunai_ichiban_stock()
returns table(prize_id text, remaining bigint)
language sql stable security definer set search_path = public
as $$
  select t.prize_id, count(*)::bigint
  from public.qiunai_ichiban_tickets t
  where t.draw_id is null
  group by t.prize_id;
$$;

create or replace function public.qiunai_ichiban_draw_asd(
  p_discord_user_id text,
  p_request_id text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  existing public.qiunai_ichiban_draws%rowtype;
  ticket public.qiunai_ichiban_tickets%rowtype;
  v_draw_id uuid;
  balance_after integer;
  prize_credit integer := 0;
  last_one boolean;
begin
  if p_discord_user_id !~ '^[0-9]{15,25}$' or
     p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception '一番賞請求資料格式錯誤';
  end if;

  -- 所有抽紙共用鎖：防止同時抽中最後一張或超賣。
  perform 1 from public.qiunai_ichiban_pool_mutex where id = 1 for update;
  select * into existing from public.qiunai_ichiban_draws
  where payment_provider = 'asd' and payment_reference = p_request_id;
  if found then
    if existing.discord_user_id <> p_discord_user_id then
      raise exception '一番賞請求編號已被其他使用者使用';
    end if;
    return jsonb_build_object('already_processed', true, 'draw_id', existing.id,
      'prize_id', existing.prize_id, 'ticket_no', existing.ticket_no,
      'is_last_one', existing.is_last_one);
  end if;

  select * into ticket from public.qiunai_ichiban_tickets
  where draw_id is null order by random() limit 1;
  if not found then raise exception '一番賞已全數抽完'; end if;
  select count(*) = 1 into last_one from public.qiunai_ichiban_tickets where draw_id is null;

  insert into public.users(user_id, coins) values (p_discord_user_id, 0)
    on conflict (user_id) do nothing;
  update public.users set coins = coalesce(coins, 0) - 300
  where user_id = p_discord_user_id and coalesce(coins, 0) >= 300
  returning coins into balance_after;
  if not found then raise exception 'ASD 餘額不足'; end if;

  insert into public.wallet_logs(user_id, type, amount, balance, note)
  values (p_discord_user_id, '扣款', -300, balance_after, '秋奈一番賞｜' || p_request_id);

  insert into public.qiunai_ichiban_draws(
    discord_user_id, payment_provider, payment_reference, paid_amount,
    prize_id, ticket_no, is_last_one
  ) values (p_discord_user_id, 'asd', p_request_id, 300,
    ticket.prize_id, ticket.ticket_no, last_one)
  returning id into v_draw_id;

  update public.qiunai_ichiban_tickets
  set draw_id = v_draw_id, drawn_at = now()
  where ticket_no = ticket.ticket_no;

  if ticket.prize_id ~ '^[a-f]-asd-[0-9]+$' then
    prize_credit := substring(ticket.prize_id from 'asd-([0-9]+)$')::integer;
    update public.users set coins = coins + prize_credit
      where user_id = p_discord_user_id returning coins into balance_after;
    insert into public.wallet_logs(user_id, type, amount, balance, note)
    values (p_discord_user_id, '抽獎獎品', prize_credit, balance_after,
      '秋奈一番賞 ASD 獎品｜' || v_draw_id);
  end if;

  return jsonb_build_object('already_processed', false, 'draw_id', v_draw_id,
    'prize_id', ticket.prize_id, 'ticket_no', ticket.ticket_no,
    'is_last_one', last_one, 'balance', balance_after);
end;
$$;

revoke all on table public.qiunai_ichiban_prizes,
  public.qiunai_ichiban_tickets, public.qiunai_ichiban_draws,
  public.qiunai_ichiban_pool_mutex from anon, authenticated;
revoke all on function public.qiunai_ichiban_draw_asd(text, text) from public, anon, authenticated;
grant execute on function public.qiunai_ichiban_draw_asd(text, text) to service_role;
grant execute on function public.qiunai_ichiban_stock() to anon, authenticated, service_role;
