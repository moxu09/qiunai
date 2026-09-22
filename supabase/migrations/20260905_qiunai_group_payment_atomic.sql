begin;
create or replace function public.qiunai_pay_service_group(
 p_group_id text, p_customer_id text, p_guild_id text, p_method text
) returns jsonb language plpgsql set search_path = public as $$
declare
 row_order public.play_orders%rowtype;
 ids uuid[] := '{}';
 order_id uuid;
 receipt jsonb;
 total numeric := 0;
 result_orders jsonb;
begin
 if p_method not in ('wallet','monthly') then raise exception 'invalid payment method'; end if;
 for row_order in select * from public.play_orders
   where order_group_id=p_group_id and guild_id=p_guild_id order by id for update
 loop
   if row_order.customer_id is distinct from p_customer_id or coalesce(row_order.paid,false)
     or coalesce(row_order.is_deleted,false) or row_order.status is null
     or row_order.status not in ('waiting_payment','quoted','waiting_confirm') then
     raise exception '訂單已付款或已結束，未重複扣款';
   end if;
   ids := array_append(ids,row_order.id);
 end loop;
 if cardinality(ids) <> 2 then raise exception '分單資料不完整，未扣款'; end if;
 foreach order_id in array ids loop
   if p_method='wallet' then
     select to_jsonb(public.pay_play_order_with_wallet(order_id)) into receipt;
   else
     select to_jsonb(public.pay_play_order_with_monthly(order_id)) into receipt;
   end if;
   total := total + coalesce((receipt->>'amount')::numeric,0);
 end loop;
 update public.play_orders set status='pending',quote_status='dispatched',updated_at=now() where id=any(ids);
 select jsonb_agg(to_jsonb(o) order by o.id) into result_orders from public.play_orders o where o.id=any(ids);
 return jsonb_build_object('amount',total,'receipt',receipt,'orders',result_orders);
end; $$;
revoke all on function public.qiunai_pay_service_group(text,text,text,text) from public, anon, authenticated;
grant execute on function public.qiunai_pay_service_group(text,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
