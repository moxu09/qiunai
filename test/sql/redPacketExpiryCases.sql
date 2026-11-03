do $$declare id1 bigint;id2 bigint;id3 bigint;id4 bigint;r jsonb; b integer; begin
insert into public.users(user_id,coins)values('999999999999999991',5);
-- Entire packet unclaimed after 24h: refund once and reject late claim.
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,organization_code,created_at)values('FULL','999999999999999991',100,100,2,2,'qiunai',now()-interval '25 hours')returning id into id1;
insert into public.red_packet_claims(packet_id,user_id,amount)values(id1,'__pending_red_packet_'||id1||'_0',40),(id1,'__pending_red_packet_'||id1||'_1',60);
r:=public.qiunai_expire_red_packet(id1);if not(r->>'refunded')::boolean or(r->>'amount')::integer<>100 then raise exception 'full refund failed';end if;
r:=public.qiunai_expire_red_packet(id1);if(r->>'refunded')::boolean then raise exception 'double refund';end if;
r:=public.qiunai_claim_red_packet(id1,'999999999999999992');if(r->>'success')::boolean then raise exception 'expired claim succeeded';end if;
if(select coins from public.users where user_id='999999999999999991')<>105 then raise exception 'balance wrong';end if;
-- Before deadline, prepared claim works. At expiry, refund only remaining.
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,organization_code)values('PARTIAL','999999999999999991',100,100,2,2,'qiunai')returning id into id2;
insert into public.red_packet_claims(packet_id,user_id,amount)values(id2,'__pending_red_packet_'||id2||'_0',40),(id2,'__pending_red_packet_'||id2||'_1',60);
r:=public.qiunai_expire_red_packet(id2);if(r->>'refunded')::boolean then raise exception 'early refund';end if;
r:=public.qiunai_claim_red_packet(id2,'999999999999999992');if not(r->>'success')::boolean or(r->>'claim_amount')::integer<>40 then raise exception 'claim before deadline failed';end if;
update public.red_packets set expires_at=clock_timestamp()-interval '1 second' where id=id2;
r:=public.qiunai_claim_red_packet(id2,'999999999999999993');if(r->>'success')::boolean then raise exception 'late claim';end if;
if(select coins from public.users where user_id='999999999999999991')<>165 or(select coins from public.users where user_id='999999999999999992')<>40 or exists(select 1 from public.users where user_id='999999999999999993') then raise exception 'partial refund wrong';end if;
-- No refund for paid-out packet or another store.
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,organization_code,status,created_at)values('FINISHED','999999999999999991',20,0,1,0,'qiunai','finished',now()-interval '25 hours')returning id into id3;
r:=public.qiunai_expire_red_packet(id3);if(r->>'refunded')::boolean then raise exception 'finished refunded';end if;
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,created_at)values('OTHER','999999999999999991',20,20,1,1,now()-interval '25 hours')returning id into id4;
r:=public.qiunai_expire_red_packet(id4);if(r->>'refunded')::boolean then raise exception 'unknown store refunded';end if;
-- Verified adoption uses original send time and can refund old Qiunai packet.
update public.red_packets set organization_code='qiunai' where id=id4;
r:=public.qiunai_expire_red_packet(id4);if not(r->>'refunded')::boolean or(select coins from public.users where user_id='999999999999999991')<>185 then raise exception 'legacy adoption refund wrong';end if;
if(select count(*) from public.wallet_logs where type='紅包到期退回')<>3 then raise exception 'refund log wrong';end if;
end $$;
-- Inconsistent packet must not refund.
do $$declare p bigint;blocked boolean:=false;begin
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,organization_code,created_at)values('BROKEN','999999999999999991',100,90,2,2,'qiunai',now()-interval '25 hours')returning id into p;
begin perform public.qiunai_expire_red_packet(p);exception when others then blocked:=true;end;
if not blocked or(select coins from public.users where user_id='999999999999999991')<>185 then raise exception 'inconsistent packet refunded';end if;
end $$;
-- A failed ledger write must roll back wallet credit and packet state.
create function test_fail_log()returns trigger language plpgsql as $$begin if new.type='紅包到期退回' then raise exception 'synthetic log failure';end if;return new;end$$;
create trigger test_fail_log before insert on public.wallet_logs for each row execute function test_fail_log();
do $$declare p bigint;blocked boolean:=false;begin
insert into public.red_packets(packet_no,sender_id,total_amount,remaining_amount,total_count,remaining_count,organization_code,created_at)values('ROLLBACK','999999999999999991',100,100,2,2,'qiunai',now()-interval '25 hours')returning id into p;
begin perform public.qiunai_expire_red_packet(p);exception when others then blocked:=true;end;
if not blocked or(select coins from public.users where user_id='999999999999999991')<>185 or(select expired_at from public.red_packets where id=p)is not null then raise exception 'partial transaction committed';end if;
end $$;
select 'PASS' as red_packet_expiry_test;
