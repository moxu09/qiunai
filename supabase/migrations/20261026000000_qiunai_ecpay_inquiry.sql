-- 查單節流與租約僅供現有 service_role 使用；不授予前台權限。
create table if not exists public.ecpay_inquiry_limiter (
 id boolean primary key default true check(id),
 next_slot_at timestamptz not null default '-infinity',
 blocked_until timestamptz not null default '-infinity'
);
insert into public.ecpay_inquiry_limiter(id) values(true) on conflict do nothing;
create table if not exists public.ecpay_service_inquiries (
 merchant_trade_no text primary key,
 next_check_at timestamptz not null default '-infinity',
 last_checked_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 attempts integer not null default 0,
 last_status text,
 last_error text,
 review_required boolean not null default false
);
alter table public.ecpay_inquiry_limiter enable row level security;
alter table public.ecpay_service_inquiries enable row level security;
revoke all on public.ecpay_inquiry_limiter,public.ecpay_service_inquiries from public,anon,authenticated;
grant all on public.ecpay_inquiry_limiter,public.ecpay_service_inquiries to service_role;

create or replace function public.ecpay_claim_service_inquiry(p_merchant_trade_no text,p_interval_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=public as $$
declare lim public.ecpay_inquiry_limiter%rowtype; q public.ecpay_service_inquiries%rowtype;
 p public.ecpay_service_payments%rowtype; deadline timestamptz; token uuid;
begin
 select * into lim from public.ecpay_inquiry_limiter where id=true for update;
 select * into p from public.ecpay_service_payments where merchant_trade_no=p_merchant_trade_no;
 if not found or p.organization_code<>'qiunai' then raise exception '找不到秋奈付款單'; end if;
 if p.status<>'pending' then return jsonb_build_object('status',p.status,'fulfillment_status',p.fulfillment_status); end if;
 if split_part(coalesce(p.raw_result->>'PaymentType',p.metadata->>'ecpay_direct_method',''),'_',1) not in ('ATM','CVS') then
  return jsonb_build_object('status','unsupported'); end if;
 insert into public.ecpay_service_inquiries(merchant_trade_no) values(p_merchant_trade_no) on conflict do nothing;
 select * into q from public.ecpay_service_inquiries where merchant_trade_no=p_merchant_trade_no for update;
 if q.review_required then return jsonb_build_object('status','needs_review'); end if;
 deadline:=greatest(lim.blocked_until,lim.next_slot_at,q.next_check_at,coalesce(q.lease_until,'-infinity'));
 if deadline>clock_timestamp() then return jsonb_build_object('status','cooldown','retry_after',greatest(1,ceil(extract(epoch from deadline-clock_timestamp()))::integer)); end if;
 token:=gen_random_uuid();
 update public.ecpay_inquiry_limiter set next_slot_at=clock_timestamp()+interval '6 seconds' where id=true;
 update public.ecpay_service_inquiries set lease_token=token,lease_until=clock_timestamp()+interval '60 seconds',
  next_check_at=clock_timestamp()+make_interval(secs=>greatest(60,least(coalesce(p_interval_seconds,300),3600))),
  last_checked_at=clock_timestamp(),attempts=attempts+1 where merchant_trade_no=p_merchant_trade_no;
 return jsonb_build_object('status','claimed','lease_token',token);
end; $$;

create or replace function public.ecpay_finish_service_inquiry(
 p_merchant_trade_no text,p_lease_token uuid,p_remote_status text,p_trade_no text default null,
 p_amount integer default null,p_payment_date text default null,p_raw_result jsonb default '{}'::jsonb,
 p_error text default null,p_rate_limited boolean default false
) returns jsonb language plpgsql security definer set search_path=public as $$
declare q public.ecpay_service_inquiries%rowtype; p public.ecpay_service_payments%rowtype;
 paid_time timestamptz; needs_review boolean:=false;
begin
 perform 1 from public.ecpay_inquiry_limiter where id=true for update;
 select * into q from public.ecpay_service_inquiries where merchant_trade_no=p_merchant_trade_no for update;
 if not found or q.lease_token is distinct from p_lease_token or q.lease_until<clock_timestamp() then raise exception '查單租約已失效'; end if;
 select * into p from public.ecpay_service_payments where merchant_trade_no=p_merchant_trade_no for update;
 if not found or p.organization_code<>'qiunai' then raise exception '找不到秋奈付款單'; end if;
 if p_rate_limited then
  update public.ecpay_inquiry_limiter set blocked_until=clock_timestamp()+interval '30 minutes' where id=true;
 end if;
 if p_error is not null then
  update public.ecpay_service_inquiries set lease_token=null,lease_until=null,last_status='error',last_error=left(p_error,200) where merchant_trade_no=p_merchant_trade_no;
  return jsonb_build_object('status','error','retry_after',case when p_rate_limited then 1800 else 300 end);
 end if;
 if p_remote_status not in ('paid','pending','failed') then raise exception '查單狀態不明'; end if;
 if p_amount is distinct from p.amount or nullif(p_trade_no,'') is null or p.raw_result->>'TradeNo' is distinct from p_trade_no then raise exception '查單金額或交易編號不符'; end if;
 if p.status='paid' and p.trade_no is distinct from p_trade_no then raise exception '已付款交易編號不符'; end if;
 if p.status='pending' and p_remote_status='paid' then
  if p_raw_result->>'SimulatePaid'='1' then raise exception '模擬付款不可入帳'; end if;
  if p.payment_kind='topup' and not exists(select 1 from public.bot_financial_operations where organization_code='qiunai' and operation_key='ecpay-topup:'||p.merchant_trade_no and status='completed') then
   needs_review:=exists(select 1 from public.wallet_logs where user_id=p.user_id and amount=p.amount and type='管理員發錢' and created_at>=p.created_at)
    or exists(select 1 from public.bot_manual_topups where organization_code='qiunai' and user_id=p.user_id and amount=p.amount and status='completed' and created_at>=p.created_at);
  elsif p.payment_kind='order' then
   needs_review:=not exists(select 1 from public.play_orders where id::text=p.entity_key and guild_id='1206138511535898654' and not coalesce(paid,false) and not coalesce(is_deleted,false) and status !~* 'cancel|refund|reject|取消|退款|駁回');
  elsif p.payment_kind='extension' then
   needs_review:=not exists(select 1 from public.order_extensions where id::text=p.entity_key and guild_id='1206138511535898654' and not coalesce(paid,false) and status !~* 'cancel|refund|reject|取消|退款|駁回');
  end if;
  if not needs_review then
   if p_payment_date !~ '^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}$' or p_payment_date is null then raise exception '付款時間無效'; end if;
   paid_time:=replace(p_payment_date,'/','-')::timestamp at time zone 'Asia/Taipei';
   if paid_time<p.created_at-interval '5 minutes' or paid_time>clock_timestamp()+interval '5 minutes' then raise exception '付款時間超出範圍'; end if;
   update public.ecpay_service_payments set status='paid',trade_no=p_trade_no,payment_date=p_payment_date,paid_at=paid_time,
    raw_result=coalesce(raw_result,'{}'::jsonb)||jsonb_build_object('inquiry',p_raw_result),updated_at=clock_timestamp(),fulfillment_updated_at=clock_timestamp()
    where id=p.id returning * into p;
  end if;
 end if;
 update public.ecpay_service_inquiries set lease_token=null,lease_until=null,review_required=needs_review,
  last_status=case when needs_review then 'needs_review' else p_remote_status end,last_error=null where merchant_trade_no=p_merchant_trade_no;
 return jsonb_build_object('status',case when needs_review then 'needs_review' else p.status end,'remote_status',p_remote_status,'fulfillment_status',p.fulfillment_status);
end; $$;
revoke all on function public.ecpay_claim_service_inquiry(text,integer),public.ecpay_finish_service_inquiry(text,uuid,text,text,integer,text,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.ecpay_claim_service_inquiry(text,integer),public.ecpay_finish_service_inquiry(text,uuid,text,text,integer,text,jsonb,text,boolean) to service_role;
