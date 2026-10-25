begin;
create table if not exists public.qiunai_manual_ticket_redemptions (
 operation_key text primary key, guild_id text not null,
 user_id text not null, actor_id text not null, channel_id text not null,
 ticket_kind text not null check(ticket_kind in ('kill','ichiban','limited')),
 ticket_count integer not null check(ticket_count between 1 and 20),
 item_ids bigint[] not null, remaining_count integer not null check(remaining_count>=0),
 reason text not null, created_at timestamptz not null default now()
);
alter table public.qiunai_manual_ticket_redemptions enable row level security;
revoke all on public.qiunai_manual_ticket_redemptions from public,anon,authenticated;
grant select,insert on public.qiunai_manual_ticket_redemptions to service_role;

create or replace function public.qiunai_redeem_manual_draw_tickets(
 p_operation_key text,p_guild_id text,p_user_id text,p_actor_id text,
 p_channel_id text,p_ticket_kind text,p_ticket_count integer,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 r public.qiunai_manual_ticket_redemptions%rowtype;
 names text[]; ids bigint[]; remaining integer;
begin
 if p_guild_id is distinct from '1206138511535898654' then raise exception '此功能僅供秋奈使用'; end if;
 if p_user_id is null or p_user_id !~ '^[0-9]{17,20}$'
 or p_actor_id is null or p_actor_id !~ '^[0-9]{17,20}$'
 or p_channel_id is null or p_channel_id !~ '^[0-9]{17,20}$'
 or p_operation_key is null or p_operation_key !~ '^manual-draw-ticket:[0-9]{17,20}$'
 then raise exception '核銷識別資料不完整'; end if;
 if p_ticket_count is null or p_ticket_count not between 1 and 20 then raise exception '核銷張數須為1至20張'; end if;
 if p_reason is null or length(trim(p_reason)) not between 1 and 200 then raise exception '請填寫200字內核銷備註'; end if;
 names:=case p_ticket_kind
 when 'kill' then array['殺比死卡池抽獎券','殺比死卡池抽獎劵','殺必死卡池抽獎券','殺必死卡池抽獎劵']
 when 'ichiban' then array['秋奈一番賞抽獎券','秋奈一番賞抽獎劵']
 when 'limited' then array['限定卡池抽獎券','限定卡池抽獎劵','限定卡池獎券','限定卡池獎劵']
 else null end;
 if names is null then raise exception '抽獎券種類無效'; end if;
 perform pg_advisory_xact_lock(hashtextextended('manual-draw-ticket:'||p_operation_key,0));
 select * into r from public.qiunai_manual_ticket_redemptions where operation_key=p_operation_key;
 if found then
  if r.guild_id<>p_guild_id or r.user_id<>p_user_id or r.actor_id<>p_actor_id or r.channel_id<>p_channel_id
  or r.ticket_kind<>p_ticket_kind or r.ticket_count<>p_ticket_count or r.reason<>trim(p_reason)
  then raise exception '同一核銷編號不可更換資料'; end if;
  return to_jsonb(r)||jsonb_build_object('already_applied',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('manual-draw-ticket-user:'||p_user_id,0));
 select array_agg(id) into ids from (
  select id from public.user_items where user_id=p_user_id and guild_id=p_guild_id
  and item_type='ticket' and item_name=any(names)
  order by created_at,id limit p_ticket_count for update
 ) selected;
 if coalesce(cardinality(ids),0)<>p_ticket_count then raise exception '抽獎券不足，未扣除任何券，請重新確認'; end if;
 delete from public.user_items where id=any(ids) and user_id=p_user_id and guild_id=p_guild_id;
 select count(*) into remaining from public.user_items where user_id=p_user_id and guild_id=p_guild_id
 and item_type='ticket' and item_name=any(names);
 insert into public.qiunai_manual_ticket_redemptions(operation_key,guild_id,user_id,actor_id,channel_id,
 ticket_kind,ticket_count,item_ids,remaining_count,reason)
 values(p_operation_key,p_guild_id,p_user_id,p_actor_id,p_channel_id,p_ticket_kind,p_ticket_count,ids,remaining,trim(p_reason)) returning * into r;
 return to_jsonb(r)||jsonb_build_object('already_applied',false);
end;
$$;
revoke all on function public.qiunai_redeem_manual_draw_tickets(text,text,text,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.qiunai_redeem_manual_draw_tickets(text,text,text,text,text,text,integer,text) to service_role;
notify pgrst,'reload schema';
commit;
