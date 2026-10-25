-- Temporary synthetic inventory only. All inserts, redemptions and audit rows are rolled back.
begin;
do $$
declare u text := '900000000000000001'; g text := '1206138511535898654'; r jsonb;
begin
 if exists(select 1 from public.user_items where user_id=u)
 or exists(select 1 from public.users where user_id=u)
 or exists(select 1 from public.qiunai_manual_ticket_redemptions where user_id=u)
 then raise exception '測試身分已存在，停止測試以免碰觸既有資料'; end if;
 insert into public.user_items(user_id,guild_id,item_name,item_type,description)
 values (u,g,'殺比死卡池抽獎劵','ticket','rollback-only synthetic fixture'),
 (u,g,'殺必死卡池抽獎券','ticket','rollback-only synthetic fixture'),
 (u,g,'殺比死卡池抽獎券','ticket','rollback-only synthetic fixture'),
 (u,'1501098191813214312','殺必死卡池抽獎券','ticket','rollback-only synthetic fixture'),
 (u,g,'殺必死卡池抽獎券','coupon','rollback-only synthetic fixture');
 r := public.qiunai_redeem_manual_draw_tickets('manual-draw-ticket:900000000000000004',g,u,'900000000000000002','900000000000000003','kill',2,'rollback-only self test');
 if (r->>'remaining_count')::integer<>1 or (r->>'already_applied')::boolean then raise exception '扣券結果不符'; end if;
 r := public.qiunai_redeem_manual_draw_tickets('manual-draw-ticket:900000000000000004',g,u,'900000000000000002','900000000000000003','kill',2,'rollback-only self test');
 if not (r->>'already_applied')::boolean then raise exception '防重複結果不符'; end if;
 begin
  perform public.qiunai_redeem_manual_draw_tickets('manual-draw-ticket:900000000000000005',g,u,'900000000000000002','900000000000000003','kill',2,'rollback-only self test');
  raise exception '券不足卻核銷成功';
 exception when others then if sqlerrm not like '%抽獎券不足%' then raise; end if; end;
 if (select count(*) from public.user_items where user_id=u)<>3 then raise exception '有重複扣券或跨店扣券'; end if;
 if (select count(*) from public.qiunai_manual_ticket_redemptions where user_id=u)<>1 then raise exception '核銷紀錄數不符'; end if;
 if has_function_privilege('authenticated','public.qiunai_redeem_manual_draw_tickets(text,text,text,text,text,text,integer,text)','EXECUTE')
 or has_function_privilege('anon','public.qiunai_redeem_manual_draw_tickets(text,text,text,text,text,text,integer,text)','EXECUTE')
 then raise exception '一般會員不應有直接核銷權限'; end if;
end $$;
rollback;
select 'PASS: transactional redemption, retry deduplication, insufficient-ticket rollback, guild isolation, restricted RPC permissions; all fixtures rolled back' as verification;
