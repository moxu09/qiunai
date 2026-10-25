// 僅隔離資料庫測試，沒有任何正式環境憑證或網路操作。
const {PGlite}=require(process.env.MEMBERSHIP_PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
async function setup({used=false,later=false}={}){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create table user_vips(guild_id text,user_id text,level_key text,level_name text,total_spent integer,total_topup integer,highest_single_topup integer);
 create table qiunai_membership_grandfather_20261016(guild_id text,user_id text,previous_state jsonb);
 create table vip_levels(guild_id text,level_key text,sort_order integer);
 create table bot_vip_reward_operations(organization_code text,guild_id text,user_id text,level_key text,role_id text,reward_note text,created_at timestamptz,reward_asd integer,reward_points integer,delivery_status text);
 create table qiunai_membership_ticket_grants(guild_id text,user_id text,level_key text,tickets jsonb,created_at timestamptz);
 create table qiunai_membership_upgrade_entitlements(guild_id text,user_id text,level_key text,status text,created_at timestamptz);
 create table user_items(id serial,user_id text,guild_id text,description text,item_type text,created_at timestamptz);
 create table vip_upgrade_logs(guild_id text,user_id text,new_level_key text,created_at timestamptz,reward_asd integer,reward_points integer);
 create table qiunai_vip_channel_deliveries(guild_id text,user_id text,level_key text);
 create table qiunai_vip_point_logs(user_id text,operation_key text,created_at timestamptz,amount integer);
 insert into vip_levels values('1206138511535898654','vip0',1),('1206138511535898654','vip1',2);
 insert into user_vips select '1206138511535898654',n::text,'vip1','目前會員',12345,500,500 from generate_series(1,95)n;
 insert into qiunai_membership_grandfather_20261016 select guild_id,user_id,jsonb_build_object('level_key',null,'level_name',null,'total_spent',999) from user_vips;
 insert into bot_vip_reward_operations select 'qiunai',v.guild_id,v.user_id,'vip1','role','福利','2026-10-15 17:05:00+00',0,0,'completed' from user_vips v;
 insert into bot_vip_reward_operations select 'qiunai',v.guild_id,v.user_id,'vip0','role','福利','2026-10-15 17:05:00+00',0,0,'completed' from user_vips v where user_id::int<=7;
 insert into qiunai_membership_ticket_grants select guild_id,user_id,level_key,'[]','2026-10-15 17:05:00+00' from bot_vip_reward_operations;
 insert into qiunai_membership_upgrade_entitlements select guild_id,user_id,level_key,'pending','2026-10-15 17:05:00+00' from bot_vip_reward_operations;
 insert into vip_upgrade_logs select guild_id,user_id,level_key,created_at,0,0 from bot_vip_reward_operations;
 insert into qiunai_vip_channel_deliveries select guild_id,user_id,level_key from bot_vip_reward_operations;
 insert into qiunai_vip_point_logs select user_id,'reward:'||user_id||':'||level_key,created_at,0 from bot_vip_reward_operations;
 insert into user_items(user_id,guild_id,description,item_type,created_at) select user_id,guild_id,'會員升級福利｜'||level_key||'｜請聯繫客服核銷兌用；不會自動抽獎或扣款','ticket',created_at from bot_vip_reward_operations;
 insert into user_items(user_id,guild_id,description,item_type,created_at) select user_id,guild_id,'會員升級福利｜'||level_key||'｜請聯繫客服核銷兌用；不會自動抽獎或扣款','ticket',created_at from bot_vip_reward_operations where level_key='vip1' and user_id::int<=20;
 insert into user_items(user_id,guild_id,description,item_type,created_at) values('1','1206138511535898654','原有福利','coupon','2026-09-01');
 insert into vip_upgrade_logs values('1206138511535898654','1','original','2026-10-14',100,100);
 `);if(used)await db.exec('delete from user_items where id=1');if(later)await db.exec("insert into vip_upgrade_logs values('1206138511535898654','1','later','2026-10-15 17:13:00+00',0,5)");return db;
}
async function main(){const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261016050000_revert_mistaken_membership_backfill.sql'),'utf8');
 const db=await setup();await db.exec(sql);await db.exec(sql);
 assert.equal((await db.query('select count(*)::int n from user_vips where level_key is null')).rows[0].n,95);
 assert.equal((await db.query('select sum(total_spent)::int n from user_vips')).rows[0].n,95*12345);
 assert.equal((await db.query('select count(*)::int n from user_items')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from vip_upgrade_logs')).rows[0].n,1);
 assert.equal((await db.query('select jsonb_array_length(payload->\'items\')::int n from qiunai_membership_backfill_rollback')).rows[0].n,122);
 await db.close();
 for(const args of [{used:true},{later:true}]){const d=await setup(args);await assert.rejects(d.exec(sql),/券已使用|有效升級/);await d.exec('rollback');assert.equal((await d.query('select count(*)::int n from user_vips where level_key=\'vip1\'')).rows[0].n,95);await d.close();}
 console.log('隔離 PostgreSQL：精準撤回、122張券封存、保留最新累積與原福利、重跑冪等、已用券及後續合法升級全數通過');}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
