-- 優惠券先存完整快照再原子移除；取消未付款訂單時防重複返還。
begin;
alter table public.used_coupons add column if not exists consumption_key text;
create unique index if not exists used_coupons_consumption_key_uidx on public.used_coupons(consumption_key);
create or replace function public.qiunai_consume_coupon_atomic(p_user_id text,p_item_id bigint,p_key text,p_order_id text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.user_items%rowtype; used public.used_coupons%rowtype;
begin
 if p_key is null or length(p_key)>200 or p_user_id is null then raise exception '優惠券參數錯誤'; end if;
 perform pg_advisory_xact_lock(hashtextextended('qiunai-coupon:'||p_key,0));
 select * into used from public.used_coupons where consumption_key=p_key for update;
 if found then
  if used.user_id<>p_user_id or used.item_id<>p_item_id or used.restored_at is not null then raise exception '這筆優惠券流程已變動'; end if;
  return to_jsonb(used);
 end if;
 select * into item from public.user_items where id=p_item_id and user_id=p_user_id for update;
 if not found or (item.guild_id is not null and item.guild_id<>'1206138511535898654') or not(item.item_type='coupon' or item.item_name like '%券%') then raise exception '找不到可使用的秋奈優惠券'; end if;
 if p_order_id is not null then
  perform 1 from public.play_orders where id::text=p_order_id and guild_id='1206138511535898654' and customer_id=p_user_id and not coalesce(paid,false) and not coalesce(is_deleted,false) and status not in('cancelled','canceled','completed','refunded') for update;
  if not found then raise exception '訂單已付款或不能使用優惠券'; end if;
 end if;
 insert into public.used_coupons(user_id,item_id,item_name,description,order_id,coupon_snapshot,consumption_key)
 values(p_user_id,item.id,item.item_name,item.description,p_order_id,to_jsonb(item),p_key) returning * into used;
 delete from public.user_items where id=item.id and user_id=p_user_id;
 return to_jsonb(used);
end $$;
create or replace function public.qiunai_apply_quote_coupon(p_user_id text,p_order_id uuid,p_item_id bigint,p_rate numeric,p_discount integer,p_final integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.play_orders%rowtype; consumed jsonb;
begin
 select * into o from public.play_orders where id=p_order_id and customer_id=p_user_id and guild_id='1206138511535898654' for update;
 if not found or coalesce(o.paid,false) or coalesce(o.is_deleted,false) or o.status in('cancelled','canceled','completed','refunded') then raise exception '訂單已付款或不可修改'; end if;
 if o.vip_point_checkout_key is not null then
  if o.coupon_item_id=p_item_id and exists(select 1 from public.used_coupons where consumption_key='qiunai:quote:'||p_order_id and user_id=p_user_id and restored_at is null) then return to_jsonb(o); end if;
  raise exception '已進入付款流程，不能再次更換優惠券';
 end if;
 if p_discount<0 or p_final<0 or p_final+p_discount<>coalesce(o.original_price,o.price,o.final_price) then raise exception '優惠券金額與訂單不一致'; end if;
 consumed:=public.qiunai_consume_coupon_atomic(p_user_id,p_item_id,'qiunai:quote:'||p_order_id,p_order_id::text);
 update public.play_orders set discount_rate=p_rate,discount_amount=p_discount,final_price=p_final,coupon_text=consumed->>'item_name',coupon_name=consumed->>'item_name',coupon_item_id=p_item_id,coupon_consumed_at=now(),updated_at=now() where id=p_order_id returning * into o;
 return to_jsonb(o);
end $$;
create or replace function public.qiunai_bind_consumed_coupon(p_user_id text,p_key text,p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare used public.used_coupons%rowtype;
begin
 select * into used from public.used_coupons where consumption_key=p_key and user_id=p_user_id for update;
 if not found or used.restored_at is not null then raise exception '優惠券保留已失效'; end if;
 perform 1 from public.play_orders where id=p_order_id and guild_id='1206138511535898654' and customer_id=p_user_id and not coalesce(paid,false) and not coalesce(is_deleted,false) and status not in('cancelled','canceled','completed','refunded') for update;
 if not found then raise exception '優惠券不能綁定這張訂單'; end if;
 if used.order_id is not null and used.order_id<>p_order_id::text then raise exception '優惠券已綁定另一張訂單'; end if;
 update public.used_coupons set order_id=p_order_id::text where id=used.id;
 return true;
end $$;
create or replace function public.qiunai_release_unbound_coupon(p_user_id text,p_key text)
returns boolean language plpgsql security definer set search_path=public as $$
declare u public.used_coupons%rowtype; restored bigint; flow_id text; snap jsonb;
begin
 select * into u from public.used_coupons where consumption_key=p_key and user_id=p_user_id for update;
 if not found then return false; end if;
 if u.restored_at is not null then return true; end if;
 if u.order_id is not null then raise exception '優惠券已綁定訂單，請先取消原訂單'; end if;
 flow_id:=split_part(substring(p_key from length('qiunai:service:')+1),':coupon:',1);
 if exists(select 1 from public.play_orders where guild_id='1206138511535898654' and customer_id=p_user_id and service_flow_key like flow_id||':%' and not coalesce(is_deleted,false) and status not in('cancelled','canceled','abandoned')) then raise exception '訂單已建立，不能更換優惠券'; end if;
 snap:=coalesce(u.coupon_snapshot,'{}'::jsonb);
 insert into public.user_items(user_id,guild_id,item_name,description,rarity,item_type) values(p_user_id,'1206138511535898654',coalesce(snap->>'item_name',u.item_name),coalesce(snap->>'description',u.description),snap->>'rarity',coalesce(nullif(snap->>'item_type',''),'coupon')) returning id into restored;
 update public.used_coupons set restored_at=now(),restored_item_id=restored,restore_key='qiunai-unbound:'||u.id where id=u.id;
 return true;
end $$;
create or replace function public.qiunai_restore_cancelled_coupon()
returns trigger language plpgsql security definer set search_path=public as $$
declare ids uuid[]; u public.used_coupons%rowtype; restored_item bigint; snap jsonb;
begin
 if new.guild_id is distinct from '1206138511535898654' or coalesce(new.paid,false) or not(new.status in('cancelled','canceled','abandoned') or coalesce(new.is_deleted,false)) then return new; end if;
 select array_agg(id) into ids from public.play_orders where guild_id=new.guild_id and customer_id=new.customer_id and (id=new.id or (new.order_group_id is not null and order_group_id=new.order_group_id));
 if exists(select 1 from public.play_orders where id=any(ids) and (coalesce(paid,false) or not(coalesce(status,'') in('cancelled','canceled','abandoned') or coalesce(is_deleted,false)))) then return new; end if;
 for u in select * from public.used_coupons where user_id=new.customer_id and order_id=any(ids::text[]) and restored_at is null order by id for update loop
  snap:=coalesce(u.coupon_snapshot,'{}'::jsonb);
  insert into public.user_items(user_id,guild_id,item_name,description,rarity,item_type)
  values(u.user_id,'1206138511535898654',coalesce(snap->>'item_name',u.item_name),coalesce(snap->>'description',u.description),snap->>'rarity',coalesce(nullif(snap->>'item_type',''),'coupon')) returning id into restored_item;
  update public.used_coupons set restored_at=now(),restored_item_id=restored_item,restore_key='qiunai-unpaid-cancel:'||u.id where id=u.id and restored_at is null;
 end loop;
 return new;
end $$;
drop trigger if exists qiunai_restore_cancelled_coupon on public.play_orders;
create trigger qiunai_restore_cancelled_coupon after update of status,is_deleted on public.play_orders for each row execute function public.qiunai_restore_cancelled_coupon();
create or replace function public.qiunai_cancel_unsubmitted_card(p_trade_no text,p_user_id text,p_channel_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare payment public.ecpay_service_payments%rowtype; attempt public.ecpay_insite_attempts%rowtype; ids uuid[]; total_points numeric; coupon_missing boolean;
begin
 select * into payment from public.ecpay_service_payments where merchant_trade_no=p_trade_no and organization_code='qiunai' and payment_kind='order' for update;
 if not found or payment.user_id is distinct from p_user_id or payment.channel_id is distinct from p_channel_id then raise exception '這筆付款不屬於你或此頻道'; end if;
 if payment.status='failed' and payment.metadata->>'cancelled_before_submit'='true' then return jsonb_build_object('already_processed',true); end if;
 if payment.status<>'pending' or payment.trade_no is not null or payment.raw_result->>'TradeNo' is not null or payment.raw_result->>'PaymentType' is not null or payment.metadata->>'ecpay_direct_method' is not null then raise exception '已有繳費資訊或付款紀錄，需先核對結果，不能直接取消'; end if;
 select * into attempt from public.ecpay_insite_attempts where merchant_trade_no=p_trade_no for update;
 if found and (attempt.payment_kind<>'service' or attempt.status not in('token_ready','token_requested','token_failed')) then raise exception '銀行授權已送出或尚未確認，請先查詢結果'; end if;
 if exists(select 1 from public.jkopay_service_payments where organization_code='qiunai' and payment_kind='order' and entity_key=payment.entity_key and status in('pending','paid')) then raise exception '這筆另有街口付款單，請客服核對'; end if;
 if jsonb_typeof(payment.metadata->'orderIds')='array' then select array_agg(value::uuid) into ids from jsonb_array_elements_text(payment.metadata->'orderIds');
 elsif payment.entity_key ~* '^[0-9a-f-]{36}$' then ids:=array[payment.entity_key::uuid]; else raise exception '付款單缺少對應訂單'; end if;
 if coalesce(cardinality(ids),0)=0 then raise exception '找不到付款訂單'; end if;
 perform 1 from public.play_orders where id=any(ids) order by id for update;
 if (select count(*) from public.play_orders where id=any(ids) and guild_id='1206138511535898654' and customer_id=p_user_id and channel_id=p_channel_id and not coalesce(paid,false) and status not in('accepted','completed','refunded'))<>cardinality(ids) then raise exception '訂單已付款或狀態已變更'; end if;
 select coalesce(sum(points),0) into total_points from public.qiunai_vip_point_checkouts where status in('held','committed') and order_ids && ids and order_ids <@ ids;
 select exists(select 1 from public.play_orders o where o.id=any(ids) and coalesce(o.coupon_text,'') like '%券%' and not exists(select 1 from public.used_coupons u where u.user_id=p_user_id and u.order_id=any(ids::text[]))) into coupon_missing;
 update public.ecpay_insite_attempts set status='token_failed',token_expires_at=now(),updated_at=now() where merchant_trade_no=p_trade_no;
 update public.ecpay_service_payments set status='failed',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancelled_before_submit',true),updated_at=now() where id=payment.id;
 update public.play_orders set status='cancelled',quote_status='cancelled',updated_at=now() where id=any(ids);
 return jsonb_build_object('already_processed',false,'order_ids',ids,'points_released',total_points,'coupon_review_required',coupon_missing);
end $$;
revoke all on function public.qiunai_consume_coupon_atomic(text,bigint,text,text),public.qiunai_bind_consumed_coupon(text,text,uuid),public.qiunai_apply_quote_coupon(text,uuid,bigint,numeric,integer,integer),public.qiunai_release_unbound_coupon(text,text),public.qiunai_restore_cancelled_coupon(),public.qiunai_cancel_unsubmitted_card(text,text,text) from public,anon,authenticated;
grant execute on function public.qiunai_consume_coupon_atomic(text,bigint,text,text),public.qiunai_bind_consumed_coupon(text,text,uuid),public.qiunai_apply_quote_coupon(text,uuid,bigint,numeric,integer,integer),public.qiunai_release_unbound_coupon(text,text),public.qiunai_cancel_unsubmitted_card(text,text,text) to service_role;
commit;
