// Read-only audit. No reward RPC, updates, or Discord messages.
const {spawnSync}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
const {parseDatabaseTime,formatTaipeiTime}=require('../utils/taipeiTime');
const GUILD='1206138511535898654';
async function main(){
 const now=new Date(),local=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
 const start=new Date(`${local}T00:00:00+08:00`).toISOString(),end=now.toISOString();
 const envRun=spawnSync('/Users/moxu/.npm/_npx/d991ede4b4a6395c/node_modules/@railway/cli/bin/railway',['variables','--json'],{encoding:'utf8'});
 if(envRun.status)throw Error('無法讀取正式環境');const env=JSON.parse(envRun.stdout);
 const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_KEY);
 const stamp=x=>parseDatabaseTime(x)?.toISOString();
 async function all(table,filter=q=>q){let result=[];for(let offset=0;;offset+=1000){const q=await filter(db.from(table).select('*')).range(offset,offset+999);if(q.error)throw Error(`${table}: ${q.error.message}`);result.push(...q.data);if(q.data.length<1000)return result;}}
 const [claims,ops,grants,orders,cashbacks,extensions,archive,levels,users,baseline,extensionAwards]=await Promise.all([
  all('vip_upgrade_logs',q=>q.eq('guild_id',GUILD).gte('created_at',start).lte('created_at',end)),
  all('bot_vip_reward_operations',q=>q.eq('guild_id',GUILD).eq('organization_code','qiunai').gte('created_at',start).lte('created_at',end)),
  all('qiunai_membership_ticket_grants',q=>q.eq('guild_id',GUILD).gte('created_at',start)),
  all('play_orders',q=>q.eq('guild_id',GUILD).eq('paid',true).gte('paid_at',start).lte('paid_at',end)),
  all('qiunai_membership_cashbacks'),
  all('order_extensions',q=>q.eq('guild_id',GUILD).eq('paid',true).gte('paid_at',start).lte('paid_at',end)),
  all('qiunai_membership_policy_archive',q=>q.eq('version','20261016')),
  all('vip_levels',q=>q.eq('guild_id',GUILD)),
  all('user_vips',q=>q.eq('guild_id',GUILD)),
  all('qiunai_membership_grandfather_20261016',q=>q.eq('guild_id',GUILD)),
  all('qiunai_membership_extension_cashbacks'),
 ]);
 const activation=stamp(archive[0].activated_at);
 const affected=[...new Set([...claims.map(x=>x.user_id),...orders.map(x=>x.customer_id),...extensions.map(x=>x.customer_id)].filter(Boolean))];
 const logs=affected.length?await all('qiunai_vip_point_logs',q=>q.in('user_id',affected)):[];
 const items=claims.length?await all('user_items',q=>q.eq('guild_id',GUILD).in('user_id',[...new Set(claims.map(x=>x.user_id))])):[];
 const canonical=x=>x.replaceAll('劵','券').replace('限定卡池獎券','限定卡池抽獎券');
 const upgrades=[];
 for(const claim of claims){
  const op=ops.find(x=>x.user_id===claim.user_id&&x.level_key===claim.new_level_key);
  const grant=grants.find(x=>x.user_id===claim.user_id&&x.level_key===claim.new_level_key);
  const expected=[...String(claim.reward_note||'').matchAll(/(殺比死卡池抽獎[劵券]|限定卡池(?:抽)?獎[劵券]|秋奈一番賞抽獎[劵券])\s*\*([0-9]+)/g)].map(x=>({name:canonical(x[1]),count:Number(x[2])}));
  const ownItems=items.filter(x=>x.user_id===claim.user_id&&x.description===`會員升級福利｜${claim.new_level_key}｜請聯繫客服核銷兌用；不會自動抽獎或扣款`);
  const tickets=expected.map(x=>({...x,grantCount:(grant?.tickets||[]).filter(t=>canonical(t.name)===x.name).reduce((a,t)=>a+Number(t.count),0),inBag:ownItems.filter(i=>canonical(i.item_name)===x.name).length}));
  const level=levels.find(x=>x.level_key===claim.new_level_key);
  const token=env.DISCORD_TOKEN||env.TOKEN||env.BOT_TOKEN;
  const memberRes=await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members/${claim.user_id}`,{headers:{Authorization:`Bot ${token}`}});
  const member=await memberRes.json();
  upgrades.push({userId:claim.user_id,name:member.nick||member.user?.global_name||member.user?.username||null,
   from:claim.old_level_key,to:claim.new_level_key,levelName:level?.level_name,at:formatTaipeiTime(claim.created_at),
   delivery:op?.delivery_status||'missing',rolePresent:memberRes.ok?member.roles.includes(level?.role_id):null,
   tickets,discountCouponRecorded:claim.reward_coupon,discountCouponsOperation:op?.reward_coupons,
   discountBenefitLines:String(claim.reward_note||'').split('\n').filter(x=>/折.*(?:券|卷)/.test(x)).map(x=>x.replace(/<[^>]+>/g,'')),
   upgradePoints:Number(claim.reward_points||0),upgradePointLog:logs.find(x=>x.user_id===claim.user_id&&x.operation_key===`reward:${claim.user_id}:${claim.new_level_key}`)?.amount??null});
 }
 const valid=orders.filter(x=>!x.is_deleted&&!/cancel|refund|棄單|取消|退款/i.test(x.status||''));
 const results=valid.map(order=>{
  const cb=cashbacks.find(x=>x.order_id===order.id);
  const log=logs.find(x=>x.user_id===order.customer_id&&x.operation_key===`membership-cashback:${order.id}`);
  const precise=logs.find(x=>x.user_id===order.customer_id&&x.operation_key===`membership-cashback:precision:order:${order.id}`);
  const credited=Number(log?.amount||0)+Number(precise?.amount||0);
  const user=users.find(x=>x.user_id===order.customer_id);
  const base=baseline.find(x=>x.user_id===order.customer_id)?.previous_state;
  const keyAtPayment=claims.filter(x=>x.user_id===order.customer_id&&stamp(x.created_at)<=stamp(order.paid_at)).sort((a,b)=>stamp(b.created_at).localeCompare(stamp(a.created_at)))[0]?.new_level_key||base?.level_key;
  const levelAtPayment=levels.find(x=>x.level_key===keyAtPayment);
  const price=Number(order.final_price??order.price??0);
  return {id:order.id,orderNo:order.order_no,userId:order.customer_id,paidAt:formatTaipeiTime(order.paid_at),type:order.order_type,status:order.status,
   beforeActivation:stamp(order.paid_at)<activation,price,award:cb?{rate:cb.rate,basis:cb.paid_amount,points:cb.points,debtRepaid:cb.debt_repaid,reversed:cb.reversed_at,logAmount:log?credited:null}:null,
   amountChanged:cb?Number(cb.paid_amount)!==price:false,
   explainedByExtensions:cb?Number(cb.paid_amount)+extensions.filter(x=>String(x.order_id)===order.id&&!/cancel|refund/i.test(x.status||'')).reduce((n,x)=>n+Number(x.amount),0)===price:false,
   ledgerMismatch:cb?Math.round(credited*100)!==Math.round((Number(cb.points)-Number(cb.debt_repaid))*100):false,
   levelAtPayment:levelAtPayment?.level_key||null,rateAtPayment:levelAtPayment?.cashback_rate??null,currentLevel:user?.level_key||null};
 });
 console.log(JSON.stringify({readOnly:true,start:formatTaipeiTime(start),end:formatTaipeiTime(end),activation:formatTaipeiTime(activation),
  upgrades,summary:{upgradePeople:new Set(claims.map(x=>x.user_id)).size,upgradeTiers:claims.length,paidOrders:orders.length,validOrders:valid.length,excludedOrders:orders.length-valid.length,
  recordedCashbacks:results.filter(x=>x.award).length,creditedPoints:results.reduce((a,x)=>a+(x.award?x.award.points-x.award.debtRepaid:0),0)},
  missingCashbacks:results.filter(x=>!x.award),mismatches:results.filter(x=>(x.amountChanged&&!x.explainedByExtensions)||x.ledgerMismatch),
  extensions:extensions.map(x=>{const award=extensionAwards.find(a=>String(a.extension_id)===String(x.id));
   const log=logs.find(l=>l.user_id===x.customer_id&&l.operation_key===`membership-cashback:extension:${x.id}`);
   return {id:x.id,orderId:x.order_id,orderNo:x.order_no,userId:x.customer_id,amount:x.amount,status:x.status,paidAt:formatTaipeiTime(x.paid_at),
    award:award?{points:award.points,rate:award.rate,reversedAt:award.reversed_at,logAmount:log?.amount??null}:null};})},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
