// Isolated fixtures only. Does not load production credentials.
const {PGlite}=require(process.env.MEMBERSHIP_PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const file=path.join(__dirname,'../supabase/migrations/20261016070000_backfill_verified_cashback.sql');
async function fixture(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table play_orders(id uuid primary key,guild_id text,customer_id text,paid boolean,status text,is_deleted boolean default false,price integer,final_price integer,paid_at timestamp,player_count integer default 1);
 create table order_extensions(id bigint primary key,order_id text,guild_id text,customer_id text,paid boolean,status text,amount integer);
 create table qiunai_vip_point_accounts(user_id text primary key,balance integer check(balance>=0),updated_at timestamptz default now());
 create table qiunai_vip_point_logs(id uuid default gen_random_uuid(),user_id text,operation_key text unique,amount integer,note text,created_at timestamptz default now());
 create table qiunai_membership_policy_archive(version text,activated_at timestamptz);
 insert into qiunai_membership_policy_archive values('20261016','2026-10-15 16:44:27+00');
 create table vip_levels(level_key text,guild_id text,sort_order integer,membership_policy_version text,invitation_only boolean,total_spend_required integer,single_topup_required integer,cashback_rate numeric,multi_player_min_count integer,multi_player_cashback_rate numeric,level_name text);
 create table user_vips(guild_id text,user_id text,total_spent integer,highest_single_topup integer,level_key text);
 create table wallet_logs(id integer,amount integer);insert into wallet_logs values(1,99);
 insert into play_orders values('c06b8543-eb93-4955-81d6-6cac311f291f','1206138511535898654','415392271136194561',true,'completed',false,280,280,'2026-10-15 16:03:47.448969',1),
 ('2cf3f767-37c3-47f1-ad7b-aee0feda248e','1206138511535898654','1310842435672211456',true,'completed',false,582,582,'2026-10-15 19:21:13.9241',1);
 insert into order_extensions values(282,'2cf3f767-37c3-47f1-ad7b-aee0feda248e','1206138511535898654','1310842435672211456',true,'paid',240);
 insert into qiunai_vip_point_accounts(user_id,balance) values('415392271136194561',6),('1310842435672211456',11);`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261016010000_qiunai_membership_cashback.sql'),'utf8'));
 await db.exec(`insert into qiunai_membership_cashbacks(order_id,user_id,level_key,rate,paid_amount,points) values('2cf3f767-37c3-47f1-ad7b-aee0feda248e','1310842435672211456','vip5',2,342,6);`);
 return db;
}
async function main(){
 const db=await fixture(),sql=fs.readFileSync(file,'utf8');
 const bal=async uid=>(await db.query('select balance from qiunai_vip_point_accounts where user_id=$1',[uid])).rows[0].balance;
 await db.exec(sql);assert.equal(await bal('415392271136194561'),8);assert.equal(await bal('1310842435672211456'),15);
 await db.exec(sql);assert.equal(await bal('415392271136194561'),8);assert.equal(await bal('1310842435672211456'),15);
 assert.equal((await db.query('select sum(amount)::int n from qiunai_vip_point_logs')).rows[0].n,6);
 assert.equal((await db.query('select amount from wallet_logs')).rows[0].amount,99);
 await db.exec("update play_orders set paid=false,status='refunded' where id='c06b8543-eb93-4955-81d6-6cac311f291f'");
 assert.equal(await bal('415392271136194561'),6);
 await db.exec("update order_extensions set paid=false,status='refunded' where id=282");
 assert.equal(await bal('1310842435672211456'),11);
 await db.exec("update order_extensions set status='refunded' where id=282");assert.equal(await bal('1310842435672211456'),11);
 await db.close();
 const changed=await fixture();await changed.exec('update order_extensions set amount=241 where id=282');
 await assert.rejects(changed.exec(sql),/加時資料已變更/);await changed.exec('rollback');
 assert.equal((await changed.query('select sum(balance)::int n from qiunai_vip_point_accounts')).rows[0].n,17);await changed.close();
 const parent=await fixture();await parent.exec(sql);
 await parent.exec("update qiunai_vip_point_accounts set balance=2 where user_id='1310842435672211456'");
 await parent.exec("update play_orders set paid=false,status='refunded' where id='2cf3f767-37c3-47f1-ad7b-aee0feda248e'");
 const debt=(await parent.query("select points from qiunai_membership_point_debts where user_id='1310842435672211456'")).rows[0].points;
 assert.equal(debt,8); // Main 6 + extension 4, only 2 remained: no negative balance.
 assert.equal((await parent.query("select balance from qiunai_vip_point_accounts where user_id='1310842435672211456'")).rows[0].balance,0);
 await parent.close();console.log('PASS：限縮兩筆共6點、重跑不重發、來源變動整批回滾、主單與加時退款沖回、欠點不扣錢包。');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
