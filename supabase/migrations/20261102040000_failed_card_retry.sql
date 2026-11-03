begin;
set local lock_timeout='5s';
create or replace function public.ecpay_record_final_card_failure(p_trade text,p_gateway_trade text,p_amount integer,p_code integer)
returns void language plpgsql security definer set search_path=public as $$
declare p public.ecpay_service_payments%rowtype;
begin
 if p_code<=1 or p_code=10300066 or p_gateway_trade !~ '^[A-Za-z0-9]{1,20}$' then raise exception '不是已確認的付款失敗'; end if;
 select * into p from public.ecpay_service_payments where merchant_trade_no=p_trade for update;
 if not found then return; end if;
 if p.status<>'pending' or p.amount<>p_amount or p.payment_kind<>'order' or p.organization_code not in('qiunai','deepnight') or p.trade_no is not null or p.metadata ? 'ecpay_direct_method' then return; end if;
 perform 1 from public.ecpay_insite_attempts where merchant_trade_no=p_trade and payment_kind='service' and status in('creating','created') for update;
 if not found then return; end if;
 if p.metadata->'verified_card_failure'->>'trade_no'=p_gateway_trade and p.metadata->'verified_card_failure'->>'code'=p_code::text then return; end if;
 update public.ecpay_service_payments set metadata=coalesce(metadata,'{}')||jsonb_build_object('verified_card_failure',jsonb_build_object('trade_no',p_gateway_trade,'code',p_code,'recorded_at',now())),updated_at=now() where id=p.id;
end $$;
create or replace function public.ecpay_retry_failed_service_card(p_trade text,p_gateway_trade text,p_amount integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.ecpay_service_payments%rowtype; ids uuid[]; next_trade text; new_meta jsonb; gid text;
begin
 select * into p from public.ecpay_service_payments where merchant_trade_no=p_trade for update;
 if not found then raise exception '找不到付款單'; end if;
 if p.status='failed' and p.metadata ? 'card_retry_to' then return jsonb_build_object('merchant_trade_no',p.metadata->>'card_retry_to'); end if;
 if p.status<>'pending' or p.payment_kind<>'order' or p.organization_code not in('qiunai','deepnight') or p.amount<>p_amount or p.trade_no is not null or
 p.metadata->'verified_card_failure'->>'trade_no' is distinct from p_gateway_trade or p.metadata->>'cancelled_before_submit'='true' or p.metadata ? 'ecpay_direct_method' then raise exception '付款未確認失敗，不能再次刷卡'; end if;
 perform 1 from public.ecpay_insite_attempts where merchant_trade_no=p_trade and payment_kind='service' and status in('creating','created') for update;
 if not found then raise exception '付款階段已變動'; end if;
 if jsonb_typeof(p.metadata->'orderIds')='array' then select array_agg(value::uuid) into ids from jsonb_array_elements_text(p.metadata->'orderIds');
 elsif p.entity_key ~* '^[0-9a-f-]{36}$' then ids:=array[p.entity_key::uuid]; else raise exception '付款單缺少對應訂單'; end if;
 gid:=case when p.organization_code='qiunai' then '1206138511535898654' else '1501098191813214312' end;
 perform 1 from public.play_orders where id=any(ids) order by id for update;
 if coalesce(cardinality(ids),0)=0 or (select count(*) from public.play_orders where id=any(ids) and guild_id=gid and customer_id=p.user_id and not coalesce(paid,false) and not coalesce(is_deleted,false) and status not in('cancelled','canceled','accepted','completed','refunded'))<>cardinality(ids) or
 (select sum(coalesce(final_price,price,0)) from public.play_orders where id=any(ids))<>p.amount then raise exception '原訂單已付款、取消或金額變動'; end if;
 if exists(select 1 from public.jkopay_service_payments where organization_code=p.organization_code and payment_kind='order' and entity_key=p.entity_key and status in('pending','paid')) then raise exception '另有街口付款單，請客服核對'; end if;
 if p.organization_code='qiunai' and exists(select 1 from public.qiunai_vip_point_checkouts where status='released' and order_ids && ids) then raise exception '原訂單點數已返還'; end if;
 next_trade:=case when p.organization_code='qiunai' then 'QN' else 'DN' end||upper(substr(replace(gen_random_uuid()::text,'-',''),1,18));
 new_meta:=(coalesce(p.metadata,'{}')-'verified_card_failure'-'card_retry_to')||jsonb_build_object('card_retry_from',p_trade,'orderIds',to_jsonb(ids));
 update public.ecpay_service_payments set status='failed',entity_key=p.entity_key||':failed:'||p_trade,metadata=coalesce(metadata,'{}')||jsonb_build_object('card_retry_to',next_trade,'original_entity_key',p.entity_key),updated_at=now() where id=p.id;
 insert into public.ecpay_service_payments(organization_code,payment_kind,entity_key,merchant_trade_no,user_id,amount,channel_id,description,metadata)
 values(p.organization_code,p.payment_kind,p.entity_key,next_trade,p.user_id,p.amount,p.channel_id,p.description,new_meta);
 return jsonb_build_object('merchant_trade_no',next_trade);
end $$;
revoke all on function public.ecpay_record_final_card_failure(text,text,integer,integer),public.ecpay_retry_failed_service_card(text,text,integer) from public,anon,authenticated;
grant execute on function public.ecpay_record_final_card_failure(text,text,integer,integer),public.ecpay_retry_failed_service_card(text,text,integer) to service_role;
create or replace function public.qiunai_cancel_unsubmitted_card(p_trade_no text,p_user_id text,p_channel_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare payment public.ecpay_service_payments%rowtype; attempt public.ecpay_insite_attempts%rowtype; ids uuid[]; total_points numeric; coupon_missing boolean;
begin
 select * into payment from public.ecpay_service_payments where merchant_trade_no=(with recursive chain as (
 select merchant_trade_no,metadata,status,0 as depth from public.ecpay_service_payments where merchant_trade_no=p_trade_no
 union all select n.merchant_trade_no,n.metadata,n.status,c.depth+1 from chain c join public.ecpay_service_payments n on n.merchant_trade_no=c.metadata->>'card_retry_to' where c.status='failed' and c.depth<20
) select merchant_trade_no from chain order by depth desc limit 1) and organization_code='qiunai' and payment_kind='order' for update;
 if not found or payment.user_id is distinct from p_user_id or payment.channel_id is distinct from p_channel_id then raise exception '這筆付款不屬於你或此頻道'; end if;
 if payment.status='failed' and payment.metadata->>'cancelled_before_submit'='true' then return jsonb_build_object('already_processed',true); end if;
 if payment.status<>'pending' or payment.trade_no is not null or payment.raw_result->>'TradeNo' is not null or payment.raw_result->>'PaymentType' is not null or payment.metadata->>'ecpay_direct_method' is not null then raise exception '已有繳費資訊或付款紀錄，需先核對結果，不能直接取消'; end if;
 select * into attempt from public.ecpay_insite_attempts where merchant_trade_no=payment.merchant_trade_no for update;
 if found and (attempt.payment_kind<>'service' or attempt.status not in('token_ready','token_requested','token_failed')) then raise exception '銀行授權已送出或尚未確認，請先查詢結果'; end if;
 if exists(select 1 from public.jkopay_service_payments where organization_code='qiunai' and payment_kind='order' and entity_key=payment.entity_key and status in('pending','paid')) then raise exception '這筆另有街口付款單，請客服核對'; end if;
 if jsonb_typeof(payment.metadata->'orderIds')='array' then select array_agg(value::uuid) into ids from jsonb_array_elements_text(payment.metadata->'orderIds');
 elsif payment.entity_key ~* '^[0-9a-f-]{36}$' then ids:=array[payment.entity_key::uuid]; else raise exception '付款單缺少對應訂單'; end if;
 if coalesce(cardinality(ids),0)=0 then raise exception '找不到付款訂單'; end if;
 perform 1 from public.play_orders where id=any(ids) order by id for update;
 if (select count(*) from public.play_orders where id=any(ids) and guild_id='1206138511535898654' and customer_id=p_user_id and channel_id=p_channel_id and not coalesce(paid,false) and status not in('accepted','completed','refunded'))<>cardinality(ids) then raise exception '訂單已付款或狀態已變更'; end if;
 select coalesce(sum(points),0) into total_points from public.qiunai_vip_point_checkouts where status in('held','committed') and order_ids && ids and order_ids <@ ids;
 select exists(select 1 from public.play_orders o where o.id=any(ids) and coalesce(o.coupon_text,'') like '%券%' and not exists(select 1 from public.used_coupons u where u.user_id=p_user_id and u.order_id=any(ids::text[]))) into coupon_missing;
 update public.ecpay_insite_attempts set status='token_failed',token_expires_at=now(),updated_at=now() where merchant_trade_no=payment.merchant_trade_no;
 update public.ecpay_service_payments set status='failed',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancelled_before_submit',true),updated_at=now() where id=payment.id;
 update public.play_orders set status='cancelled',quote_status='cancelled',updated_at=now() where id=any(ids);
 return jsonb_build_object('already_processed',false,'order_ids',ids,'points_released',total_points,'coupon_review_required',coupon_missing);
end $$;

notify pgrst,'reload schema';
commit;
