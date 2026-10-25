-- Run inside a transaction after installing a transaction-local copy of the
-- functions with their cutover date moved into the past. ALWAYS ROLLBACK.
do $$
declare r jsonb; b integer; oid uuid:=gen_random_uuid(); oid2 uuid:=gen_random_uuid(); oid3 uuid:=gen_random_uuid();
begin
  insert into public.qiunai_vip_point_accounts(user_id,balance) values('__vip_points_test__',100);
  r:=public.qiunai_reserve_vip_points('__vip_points_test__','test:points',80,true);
  if (r->>'points')::integer<>40 or (r->>'amount_due')::integer<>40 then raise exception '折後80元必須最多折抵40點'; end if;
  r:=public.qiunai_reserve_vip_points('__vip_points_test__','test:points',80,true);
  if (r->>'balance')::integer<>60 then raise exception '重試不可重扣'; end if;
  r:=public.qiunai_reserve_vip_points('__vip_points_test__','test:other',100,true);
  if (r->>'balance')::integer<>10 then raise exception '多單不得超用餘額'; end if;
  perform public.qiunai_reserve_vip_points('__vip_points_test__','test:other',100,false);
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_points_test__';
  if b<>60 then raise exception '關閉點數應釋回保留'; end if;
  insert into public.play_orders(id,guild_id,customer_id,service,price,original_price,final_price,paid,status)
    values(oid,'1206138511535898654','__vip_points_test__','點數回歸測試',100,100,40,false,'pending');
  perform public.qiunai_bind_vip_points('__vip_points_test__','test:points',array[oid]);
  update public.play_orders set paid=true where id=oid;
  update public.play_orders set paid=true where id=oid;
  if (select count(*) from public.qiunai_vip_point_logs where operation_key='spend:test:points')<>1 then raise exception '付款只能扣一次'; end if;
  update public.play_orders set status='cancelled' where id=oid;
  update public.play_orders set status='cancelled' where id=oid;
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_points_test__';
  if b<>100 then raise exception '取消只能退一次'; end if;
  perform public.qiunai_reserve_vip_points('__vip_points_test__','test:split',60,true);
  insert into public.play_orders(id,guild_id,customer_id,service,price,original_price,final_price,paid,status) values
    (oid2,'1206138511535898654','__vip_points_test__','娛樂分單測試',40,40,10,false,'pending'),
    (oid3,'1206138511535898654','__vip_points_test__','技術分單測試',80,80,20,false,'pending');
  perform public.qiunai_bind_vip_points('__vip_points_test__','test:split',array[oid2,oid3]);
  if (select sum(vip_points_used) from public.play_orders where id=any(array[oid2,oid3]))<>30
    or (select sum(discount_amount) from public.play_orders where id=any(array[oid2,oid3]))<>60 then raise exception '分單點數與優惠券需分開計算'; end if;
  update public.play_orders set paid=true where id=oid2;
  if (select status from public.qiunai_vip_point_checkouts where checkout_key='test:split')<>'held' then raise exception '分單未全付不能結算'; end if;
  update public.play_orders set paid=true where id=oid3;
  if (select status from public.qiunai_vip_point_checkouts where checkout_key='test:split')<>'committed' then raise exception '分單全付需結算'; end if;
  update public.play_orders set status='cancelled' where id=oid2;
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_points_test__';
  if b<>70 then raise exception '分單不得提前全額退款'; end if;
  update public.play_orders set status='cancelled' where id=oid3;
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_points_test__';
  if b<>100 then raise exception '分單全取消需退回30點'; end if;
  r:=public.qiunai_apply_vip_level_reward('1206138511535898654','__vip_reward_test__','vip1',null,'spend',9999,'[]'::jsonb);
  if (r->>'reward_points')::integer<>100 or (r->>'reward_asd')::integer<>0 then raise exception '新制只發點數'; end if;
  perform public.qiunai_apply_vip_level_reward('1206138511535898654','__vip_reward_test__','vip1',null,'spend',9999,'[]'::jsonb);
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_reward_test__';
  if b<>100 then raise exception '每級只能領一次'; end if;
  insert into public.vip_upgrade_logs(guild_id,user_id,new_level_key,trigger_type,trigger_amount,reward_asd)
    values('1206138511535898654','__vip_reward_test__','vip2','spend',6000,150);
  r:=public.qiunai_apply_vip_level_reward('1206138511535898654','__vip_reward_test__','vip2','vip1','spend',13214,'[]'::jsonb);
  if not coalesce((r->>'historical_claim')::boolean,false) then raise exception '已領ASD不能補點'; end if;
  select balance into b from public.qiunai_vip_point_accounts where user_id='__vip_reward_test__';
  if b<>100 then raise exception '歷史會員不可重領'; end if;
end $$;
select '點數50%上限、重試、多單保留、關閉、付款、取消、每級一次、舊ASD不補點：全部通過' as verification;
rollback;
