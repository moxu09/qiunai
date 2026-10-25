-- Synthetic fixture only: transaction is rolled back, including logs and audit records.
begin;
do $$
declare
 u text:='999999999999980001'; op text:='manual-point-deduction:999999999999980002';
 g text:='1206138511535898654'; a text:='999999999999980003'; c text:='999999999999980004';
 r jsonb; rejected boolean; v numeric;
begin
 if exists(select 1 from public.qiunai_vip_point_accounts where user_id=u)
 or exists(select 1 from public.qiunai_vip_point_logs where user_id=u)
 or exists(select 1 from public.qiunai_membership_point_debts where user_id=u)
 or exists(select 1 from public.qiunai_manual_point_deductions where user_id=u)
 then raise exception '測試身分已存在，停止'; end if;
 -- Missing account and insufficient balances must not create account, audit or log rows.
 r:=public.qiunai_deduct_manual_points(op,g,u,a,c,12.34,'ROLLBACK TEST');
 if (r->>'applied')::boolean or (r->>'available_points')::numeric<>0 then raise exception '無帳戶未正確拒絕'; end if;
 if exists(select 1 from public.qiunai_vip_point_accounts where user_id=u) then raise exception '無餘額不應建立帳戶'; end if;
 insert into public.qiunai_vip_point_accounts(user_id,balance) values(u,20);
 insert into public.qiunai_membership_point_debts(user_id,points) values(u,2.34);
 r:=public.qiunai_deduct_manual_points(op,g,u,a,c,20.01,'ROLLBACK TEST');
 if (r->>'applied')::boolean or (r->>'available_points')::numeric<>20 then raise exception '不足點數未拒絕'; end if;
 if exists(select 1 from public.qiunai_vip_point_logs where user_id=u)
 or exists(select 1 from public.qiunai_manual_point_deductions where user_id=u) then raise exception '拒絕後不應留下成功明細'; end if;
 r:=public.qiunai_deduct_manual_points(op,g,u,a,c,12.34,' ROLLBACK TEST ');
 if not(r->>'applied')::boolean or (r->>'already_applied')::boolean
 or (r->>'balance_before')::numeric<>20 or (r->>'balance_after')::numeric<>7.66 then raise exception '小數扣除錯誤'; end if;
 r:=public.qiunai_deduct_manual_points(op,g,u,a,c,12.34,'ROLLBACK TEST');
 if not(r->>'already_applied')::boolean then raise exception '重試未去重'; end if;
 if (select count(*) from public.qiunai_vip_point_logs where operation_key=op)<>1
 or (select amount from public.qiunai_vip_point_logs where operation_key=op)<>-12.34 then raise exception '扣點明細錯誤'; end if;
 if (select points from public.qiunai_membership_point_debts where user_id=u)<>2.34 then raise exception '扣點不應改欠點'; end if;
 rejected:=false;
 begin perform public.qiunai_deduct_manual_points(op,g,u,a,c,13,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '更改重試金額未拒絕'; end if;
 rejected:=false;
 begin perform public.qiunai_deduct_manual_points(op,g,u,a,c,12.34,'OTHER');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '更改重試原因未拒絕'; end if;
 foreach v in array array[0,-1,0.001,1000001]::numeric[] loop
 rejected:=false;
 begin perform public.qiunai_deduct_manual_points('manual-point-deduction:999999999999980005',g,u,a,c,v,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '無效點數未拒絕'; end if;
 end loop;
 rejected:=false;
 begin perform public.qiunai_deduct_manual_points(op,'1501098191813214312',u,a,c,12.34,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '跨店未拒絕'; end if;
 r:=public.qiunai_deduct_manual_points('manual-point-deduction:999999999999980006',g,u,a,c,7.66,'ROLLBACK TEST');
 if (r->>'balance_after')::numeric<>0 then raise exception '全額扣除錯誤'; end if;
 if (select balance from public.qiunai_vip_point_accounts where user_id=u)<>0 then raise exception '餘額錯誤'; end if;
 if has_function_privilege('anon','public.qiunai_deduct_manual_points(text,text,text,text,text,numeric,text)','execute')
 or has_function_privilege('authenticated','public.qiunai_deduct_manual_points(text,text,text,text,text,numeric,text)','execute')
 or not has_function_privilege('service_role','public.qiunai_deduct_manual_points(text,text,text,text,text,numeric,text)','execute')
 then raise exception 'RPC權限錯誤'; end if;
end $$;
rollback;
select 'PASS: decimal deduction, insufficient balance, no negative balance, retry deduplication, audit, debt unchanged, guild and ACL; all fixtures rolled back' as verification;
