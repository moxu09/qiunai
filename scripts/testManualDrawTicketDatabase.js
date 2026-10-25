const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PGlite } = require(process.env.MEMBERSHIP_PGLITE_MODULE || '@electric-sql/pglite');
async function main() {
 const db = new PGlite(), user = '900000000000000001', actor = '900000000000000002', channel = '900000000000000003', guild = '1206138511535898654';
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table user_items(id bigserial primary key,user_id text,guild_id text,item_name text,item_type text,created_at timestamptz default now());`);
 const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261020000000_manual_draw_ticket_redemption.sql'), 'utf8');
 await db.exec(sql); await db.exec(sql);
 const add = async (name, g = guild, type = 'ticket') => db.query('insert into user_items(user_id,guild_id,item_name,item_type) values($1,$2,$3,$4)', [user,g,name,type]);
 await add('殺比死卡池抽獎劵'); await add('殺必死卡池抽獎券'); await add('殺比死卡池抽獎券'); await add('秋奈一番賞抽獎券'); await add('限定卡池獎劵'); await add('殺必死卡池抽獎券', 'other'); await add('殺必死卡池抽獎券', guild, 'coupon');
 const args = ['manual-draw-ticket:900000000000000004',guild,user,actor,channel,'kill',2,'測試核銷'];
 const redeem = async (values = args) => (await db.query('select qiunai_redeem_manual_draw_tickets($1,$2,$3,$4,$5,$6,$7,$8) r', values)).rows[0].r;
 const first = await redeem(); assert.equal(first.remaining_count,1); assert.equal(first.item_ids.length,2); assert.equal(first.already_applied,false);
 assert.equal((await redeem()).already_applied,true);
 await assert.rejects(redeem(args.map((v,i) => i===6 ? 1 : v)), /不可更換/);
 const next = [...args]; next[0] = 'manual-draw-ticket:900000000000000005'; next[6] = 2;
 await assert.rejects(redeem(next), /不足/);
 assert.equal((await db.query('select count(*)::int n from qiunai_manual_ticket_redemptions')).rows[0].n,1);
 for (const [kind, key] of [['ichiban','900000000000000006'],['limited','900000000000000007']]) { const a = [...args]; a[0]='manual-draw-ticket:'+key; a[5]=kind; a[6]=1; assert.equal((await redeem(a)).remaining_count,0); }
 const cross = [...args]; cross[0]='manual-draw-ticket:900000000000000008'; cross[1]='other'; await assert.rejects(redeem(cross), /僅供秋奈/);
 await db.exec(`create function reject_ticket_audit() returns trigger language plpgsql as $$begin raise exception 'audit failure'; end$$;
 create trigger fail_audit before insert on qiunai_manual_ticket_redemptions for each row execute function reject_ticket_audit();`);
 const rollback=[...args];rollback[0]='manual-draw-ticket:900000000000000009';rollback[6]=1;
 await assert.rejects(redeem(rollback),/audit failure/);
 assert.equal((await db.query("select count(*)::int n from user_items where user_id=$1 and guild_id=$2 and item_type='ticket'",[user,guild])).rows[0].n,1);
 await db.exec('set role authenticated'); await assert.rejects(redeem(),/permission denied/); await assert.rejects(db.query('select * from qiunai_manual_ticket_redemptions'),/permission denied/); await db.exec('reset role');
 await db.close(); console.log('PASS：原子扣券與稽核、重試去重、資料變更拒絕、券不足全退回、三券種與舊名稱、其他店與非券排除、稽核失敗回滾、一般會員無執行權限。');
}
main().catch(error => { console.error(error); process.exitCode=1; });
