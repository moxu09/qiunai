-- Transactional production smoke test: all fixture changes are rolled back.
begin;
do $$
declare r jsonb; n integer; rejected boolean;
begin
 if exists(select 1 from public.qiunai_vip_point_accounts where user_id='999999999999990001') then
 raise exception '測試識別碼已存在，停止'; end if;
 insert into public.qiunai_membership_point_debts(user_id,points) values('999999999999990001',2.34);
 r:=public.qiunai_grant_manual_points('manual-cashback:999999999999990002','1206138511535898654','999999999999990001','999999999999990003','999999999999990004',12.34,'ROLLBACK TEST');
 if (r->>'credited_points')::numeric<>10 or (r->>'debt_repaid')::numeric<>2.34 or (r->>'balance_after')::numeric<>10 then raise exception '小數或欠點沖抵錯誤'; end if;
 r:=public.qiunai_grant_manual_points('manual-cashback:999999999999990002','1206138511535898654','999999999999990001','999999999999990003','999999999999990004',12.34,'ROLLBACK TEST');
 if not(r->>'already_applied')::boolean then raise exception '未正確防重複'; end if;
 select count(*) into n from public.qiunai_vip_point_logs where operation_key='manual-cashback:999999999999990002';
 if n<>1 then raise exception '重複明細'; end if;
 rejected:=false;
 begin
 perform public.qiunai_grant_manual_points('manual-cashback:999999999999990002','1206138511535898654','999999999999990001','999999999999990003','999999999999990004',13,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '改額重試未阻擋'; end if;
 rejected:=false;
 begin
 perform public.qiunai_grant_manual_points('manual-cashback:999999999999990005','1206138511535898654','999999999999990001','999999999999990003','999999999999990004',0.001,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '三位小數未阻擋'; end if;
 rejected:=false;
 begin
 perform public.qiunai_grant_manual_points('manual-cashback:999999999999990005','1501098191813214312','999999999999990001','999999999999990003','999999999999990004',1,'ROLLBACK TEST');
 exception when others then rejected:=true; end;
 if not rejected then raise exception '異店未阻擋'; end if;
 if has_function_privilege('anon','public.qiunai_grant_manual_points(text,text,text,text,text,numeric,text)','execute')
 or has_function_privilege('authenticated','public.qiunai_grant_manual_points(text,text,text,text,text,numeric,text)','execute')
 or not has_function_privilege('service_role','public.qiunai_grant_manual_points(text,text,text,text,text,numeric,text)','execute')
 then raise exception 'RPC權限錯誤'; end if;
end $$;
select 'PASS: decimals, debt, deduplication, payload binding, guild, ACL; fixture will roll back' as verification;
rollback;
