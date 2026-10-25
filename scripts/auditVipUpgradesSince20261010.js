// 唯讀：只檢查 10/10 起實際確認付款的會員。候選仍須核對，不提供 --apply。
const {spawnSync}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
const {MEMBERSHIP_LEVELS,getMembershipPromotion}=require('../config/qiunaiMembership20261016');
const GUILD='1206138511535898654',START='2026-10-09T16:00:00.000Z';
function hasEvent(events,userId,start,end){return events.some(e=>e.user_id===userId&&e.at>=start&&e.at<end);}
function findDatedCandidates({users,baseline,claims,oldLevels,events,cutover,end}){
 const claimed=(uid,key)=>claims.some(x=>x.user_id===uid&&x.new_level_key===key);
 const old=[];const current=[];
 for(const b of baseline){
  const v=b.previous_state;
  if(!hasEvent(events,b.user_id,START,cutover))continue;
  for(const l of oldLevels)if((Number(v.total_spent||0)>=l.total_spend_required||Number(v.highest_single_topup||0)>=l.single_topup_required)&&!claimed(b.user_id,l.level_key))
   old.push({user_id:b.user_id,level_key:l.level_key,policy:'20261010',status:'needs_transaction_review'});
 }
 for(const u of users){
  if(!hasEvent(events,u.user_id,cutover,end))continue;
  const before=baseline.find(x=>x.user_id===u.user_id)?.previous_state;
  const result=getMembershipPromotion({totalSpent:Number(u.total_spent||0),highestSingleTopup:Number(u.highest_single_topup||0),currentLevelKey:before?.level_key||null});
  for(const l of result.newlyCrossed)if(!claimed(u.user_id,l.levelKey))current.push({user_id:u.user_id,level_key:l.levelKey,policy:'20261016',status:'needs_transaction_review'});
 }
 return [...old,...current];
}
async function main(){
 if(process.argv.includes('--apply'))throw Error('本工具只有唯讀核對；禁止自動補發');
 const r=spawnSync('/Users/moxu/.npm/_npx/d991ede4b4a6395c/node_modules/@railway/cli/bin/railway',['variables','--json'],{encoding:'utf8'});
 if(r.status)throw Error('無法讀取正式環境');const e=JSON.parse(r.stdout);const s=createClient(e.SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY||e.SUPABASE_KEY);
 async function all(table,filter=q=>q){let result=[];for(let offset=0;;offset+=1000){const q=await filter(s.from(table).select('*')).range(offset,offset+999);if(q.error)throw Error(q.error.message);result.push(...q.data);if(q.data.length<1000)return result;}}
 const archive=(await all('qiunai_membership_policy_archive',q=>q.eq('version','20261016')))[0];
 if(!archive?.activated_at||!archive.old_points_levels?.length)throw Error('缺少當時門檻，停止核對');
 const users=await all('user_vips',q=>q.eq('guild_id',GUILD));
 const baseline=await all('qiunai_membership_grandfather_20261016',q=>q.eq('guild_id',GUILD));
 const claims=await all('vip_upgrade_logs',q=>q.eq('guild_id',GUILD));
 const orders=await all('play_orders',q=>q.eq('guild_id',GUILD).eq('paid',true).gte('paid_at',START));
 const manual=await all('bot_manual_topups',q=>q.eq('organization_code','qiunai').eq('status','completed').gte('updated_at',START));
 const jko=await all('jkopay_topup_orders',q=>q.like('platform_order_id','QIUNAI-TOP-%').eq('status','paid').gte('paid_at',START));
 const ec=await all('ecpay_service_payments',q=>q.eq('organization_code','qiunai').eq('payment_kind','topup').eq('status','paid').gte('paid_at',START));
 const stamp=x=>new Date(/[zZ]|[+-]\d\d:\d\d$/.test(x)?x:x+'Z').toISOString();
 const events=[...orders.filter(x=>!x.is_deleted&&!['cancelled','canceled','refunded'].includes(x.status)).map(x=>({user_id:x.customer_id,at:stamp(x.paid_at)})),
 ...manual.map(x=>({user_id:x.user_id,at:stamp(x.updated_at)})),...jko.map(x=>({user_id:x.user_id,at:stamp(x.paid_at)})),...ec.map(x=>({user_id:x.user_id,at:stamp(x.paid_at)}))];
 const end=new Date().toISOString(),cutover=stamp(archive.activated_at);
 const candidates=findDatedCandidates({users,baseline,claims,oldLevels:archive.old_points_levels,events,cutover,end});
 console.log(JSON.stringify({readOnly:true,start:START,end,cutover,confirmedPaymentEvents:events.length,reviewCandidates:candidates,
  policy:'只以期間實際付款參與核對，不因降低門檻重發既有會員福利；本報告不自動發獎'}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={findDatedCandidates,hasEvent};
