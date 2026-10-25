// Read-only audit; no grants, messages, or account writes.
const {execFileSync}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
async function main(){
 const env=JSON.parse(execFileSync('/Users/moxu/.npm/_npx/d991ede4b4a6395c/node_modules/@railway/cli/bin/railway',['variables','--json'],{encoding:'utf8'}));
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
 async function all(table,filter=q=>q){const rows=[];for(let i=0;;i+=1000){const r=await filter(db.from(table).select('*')).range(i,i+999);if(r.error)throw Error(table+':'+r.error.message);rows.push(...r.data);if(r.data.length<1000)return rows;}}
 const [grants,items,orders,awards,extensions,extAwards,archive,users,levels,draws]=await Promise.all([
  all('qiunai_membership_ticket_grants'),all('user_items',q=>q.ilike('item_name','%抽獎%')),
  all('play_orders',q=>q.eq('guild_id','1206138511535898654').eq('paid',true).gte('paid_at','2026-10-15T16:00:00Z')),
  all('qiunai_membership_cashbacks'),all('order_extensions',q=>q.eq('guild_id','1206138511535898654').eq('paid',true).gte('paid_at','2026-10-15T16:00:00Z')),
  all('qiunai_membership_extension_cashbacks'),all('qiunai_membership_policy_archive'),all('user_vips',q=>q.eq('guild_id','1206138511535898654')),
  all('vip_levels',q=>q.eq('guild_id','1206138511535898654')),all('qiunai_draw_redemptions')]);
 const active=orders.filter(x=>!x.is_deleted&&!/cancel|refund/i.test(x.status||''));
 console.log(JSON.stringify({grants:grants.map(x=>({user:x.user_id,level:x.level_key,tickets:x.tickets})),
  inventoryGroups:items.reduce((a,x)=>{const k=[x.item_name,x.item_type,x.guild_id].join('|');a[k]=(a[k]||0)+1;return a;},{}),
  draws:draws.map(x=>({kind:x.kind,user:x.user_id,result:x.result})),activation:archive.find(x=>x.version==='20261016')?.activated_at,
  paidOrders:active.length,missing:active.filter(x=>!awards.some(a=>a.order_id===x.id)).map(x=>({id:x.id,no:x.order_no,user:x.customer_id,status:x.status,amount:x.final_price??x.price,paidAt:x.paid_at,level:users.find(v=>v.user_id===x.customer_id)?.level_key})),
  extensions:extensions.filter(x=>!extAwards.some(a=>String(a.extension_id)===String(x.id))).map(x=>({id:x.id,orderId:x.order_id,amount:x.amount,user:x.customer_id,paidAt:x.paid_at,status:x.status})),
  truncatedPoints:awards.reduce((n,x)=>n+Math.round((Number(x.paid_amount)*Number(x.rate)/100-Number(x.points))*100)/100,0),
  rates:levels.map(x=>({key:x.level_key,rate:x.cashback_rate}))},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
