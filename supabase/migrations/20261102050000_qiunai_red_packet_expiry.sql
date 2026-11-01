begin;
set local lock_timeout='5s';
-- Red packets are bot/server-only. Keep refund snapshots private from public API clients.
alter table public.red_packets enable row level security;
alter table public.red_packet_claims enable row level security;
revoke all on table public.red_packets,public.red_packet_claims from public,anon,authenticated;
grant all on table public.red_packets,public.red_packet_claims to service_role;
alter table public.red_packets add column if not exists organization_code text;
alter table public.red_packets add column if not exists expires_at timestamptz;
alter table public.red_packets add column if not exists expired_at timestamptz;
alter table public.red_packets add column if not exists refunded_amount integer not null default 0;
alter table public.red_packets add column if not exists refund_balance integer;
alter table public.red_packets add column if not exists expiry_notified_at timestamptz;
create index if not exists qiunai_red_packets_expiry_idx on public.red_packets(expires_at,id) where organization_code='qiunai' and status='active';
create index if not exists qiunai_red_packets_notice_idx on public.red_packets(expired_at,id) where organization_code='qiunai' and expired_at is not null and expiry_notified_at is null;
create or replace function public.qiunai_red_packet_set_expiry()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.organization_code='qiunai' and (tg_op='INSERT' or old.organization_code is distinct from 'qiunai') then
  new.expires_at:=coalesce(new.created_at,now())+interval '24 hours';
 end if;
 return new;
end $$;
drop trigger if exists qiunai_red_packet_set_expiry on public.red_packets;
create trigger qiunai_red_packet_set_expiry before insert or update of organization_code on public.red_packets for each row execute function public.qiunai_red_packet_set_expiry();
create or replace function public.qiunai_expire_red_packet(p_packet_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.red_packets%rowtype; claimed_amount bigint; claimed_count integer; b integer;
begin
 select * into p from public.red_packets where id=p_packet_id for update;
 if not found or p.organization_code is distinct from 'qiunai' then return jsonb_build_object('refunded',false,'reason','not_qiunai');end if;
 if p.expired_at is not null then return jsonb_build_object('refunded',false,'reason','already_processed');end if;
 if p.expires_at is null and p.created_at is null then raise exception '紅包缺少發送時間，請人工核對';end if;
 if p.status is distinct from 'active' or coalesce(p.expires_at,p.created_at+interval '24 hours')>clock_timestamp() then return jsonb_build_object('refunded',false,'reason','not_due');end if;
 if p.remaining_amount<0 or p.remaining_amount>p.total_amount or p.remaining_count<0 or p.remaining_count>p.total_count then raise exception '紅包剩餘金額或份數異常，暫停退款並人工核對';end if;
 select coalesce(sum(amount),0),count(*) into claimed_amount,claimed_count from public.red_packet_claims where packet_id=p.id and left(user_id,length('__pending_red_packet_'||p.id||'_'))<>'__pending_red_packet_'||p.id||'_';
 if claimed_amount+p.remaining_amount<>p.total_amount or claimed_count+p.remaining_count<>p.total_count then raise exception '紅包領取明細與剩餘金額不符，暫停退款並人工核對';end if;
 if p.remaining_amount>0 then
  insert into public.users(user_id,coins)values(p.sender_id,0)on conflict(user_id)do nothing;
  update public.users set coins=coalesce(coins,0)+p.remaining_amount where user_id=p.sender_id returning coins into b;
  insert into public.wallet_logs(user_id,type,amount,balance,note)values(p.sender_id,'紅包到期退回',p.remaining_amount,b,'🧧 紅包超過24小時，退回未領餘額｜紅包編號：'||coalesce(p.packet_no,p.id::text));
 end if;
 update public.red_packets set status='cancelled',expired_at=clock_timestamp(),refunded_amount=p.remaining_amount,refund_balance=b,remaining_amount=0,remaining_count=0 where id=p.id;
 return jsonb_build_object('refunded',true,'packet_id',p.id,'amount',p.remaining_amount,'new_balance',b);
end $$;
create or replace function public.qiunai_claim_red_packet(p_packet_id bigint,p_user_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.red_packets%rowtype; result jsonb;
begin
 if p_user_id is null or p_user_id!~'^[0-9]{15,20}$' then raise exception '找不到使用者';end if;
 select * into p from public.red_packets where id=p_packet_id for update;
 if not found or p.organization_code is distinct from 'qiunai' then return jsonb_build_object('success',false,'message','找不到秋奈紅包');end if;
 if p.expired_at is null and p.status is distinct from 'active' then return jsonb_build_object('success',false,'message','紅包已結束或已被搶完');end if;
 if p.expires_at is null and p.created_at is null then raise exception '紅包缺少發送時間，請人工核對';end if;
 if p.expired_at is not null or coalesce(p.expires_at,p.created_at+interval '24 hours')<=clock_timestamp() then
  perform public.qiunai_expire_red_packet(p.id);
  return jsonb_build_object('success',false,'expired',true,'message','紅包已超過24小時，未領取的餘額已退回發送人');
 end if;
 result:=public.claim_prepared_red_packet_atomic(p_packet_id,p_user_id);
 if result is null then select to_jsonb(r) into result from public.claim_red_packet_safe(p_packet_id,p_user_id) r;end if;
 return coalesce(result,jsonb_build_object('success',false,'message','紅包領取結果不明，請稍後查詢'));
end $$;
create or replace function public.qiunai_red_packet_expiry_ready() returns boolean language sql security definer set search_path=public as $$select true$$;
revoke all on function public.qiunai_red_packet_expiry_ready(),public.qiunai_red_packet_set_expiry(),public.qiunai_expire_red_packet(bigint),public.qiunai_claim_red_packet(bigint,text) from public,anon,authenticated;
grant execute on function public.qiunai_red_packet_expiry_ready(),public.qiunai_expire_red_packet(bigint),public.qiunai_claim_red_packet(bigint,text) to service_role;
notify pgrst,'reload schema';
commit;
