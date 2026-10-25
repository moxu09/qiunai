const {createHash}=require('node:crypto');
const {taipeiPeriod}=require('./qiunaiVipRebateNotifications');
const GUILD_ID='1206138511535898654',FIRST_MONTH='2026-11-01',TABLE='qiunai_membership_monthly_coupons';
function monthlyCouponEligibility(levelKey){return levelKey==='vip8';}
function buildMonthlyCouponNotice(row){
 const marker=`月領發放編號：${row.billing_month}:${row.user_id}`;
 return{content:`🌧️ 小奈｜${row.billing_month.slice(0,7)} 會員每月優惠券\n`+
  `已自動發放 ${row.item_name} × ${row.coupon_count} 張至你的背包，無需再按領取。\n`+
  '95折券適用原價500元以內的訂單（含500元），每筆消費限用一張。\n'+
  '這是每月優惠券，與首充返利消費點數分開計算。\n可到秋奈銀行「我的背包」查看。\n'+marker,
  nonce:createHash('sha256').update(`monthly-coupon:${row.billing_month}:${row.user_id}`).digest('hex').slice(0,24),
  enforceNonce:true,allowedMentions:{parse:[]}};
}
async function processMonthlyCoupons(db,client,now=new Date()){
 const period=taipeiPeriod(now);
 if(period.month<FIRST_MONTH||period.day!==1)return{scheduled:false,granted:0,sent:0};
 const guild=await client.guilds.fetch(GUILD_ID);
 let granted=0,sent=0,grantFailed=0;
 for(let offset=0;;offset+=500){
  const users=await db.from('user_vips').select('user_id,level_key').eq('guild_id',GUILD_ID)
   .eq('level_key','vip8').order('user_id').range(offset,offset+499);
  if(users.error)throw users.error;
  for(const user of users.data||[]){
   try{await guild.members.fetch(user.user_id);}catch(error){if([10007,10013].includes(Number(error.code)))continue;throw error;}
   const award=await db.rpc('qiunai_grant_monthly_coupons',{p_user_id:user.user_id,p_billing_month:period.month});
   if(award.error){grantFailed++;console.error('[每月優惠券發放失敗]',user.user_id,award.error.message);continue;}
   if(award.data?.granted&&!award.data.already_granted)granted++;
  }
  if((users.data||[]).length<500)break;
 }
 const pending=await db.from(TABLE).select('*').eq('guild_id',GUILD_ID).eq('billing_month',period.month)
  .in('notification_status',['pending','sending','failed']).lt('attempt_count',5);
 if(pending.error)throw pending.error;
 for(const row of pending.data||[]){
  if(row.attempted_at&&now-new Date(row.attempted_at)<300000)continue;
  const stamp=now.toISOString();
  let query=db.from(TABLE).update({notification_status:'sending',attempt_count:row.attempt_count+1,attempted_at:stamp})
   .eq('guild_id',GUILD_ID).eq('user_id',row.user_id).eq('billing_month',row.billing_month)
   .eq('notification_status',row.notification_status).eq('attempt_count',row.attempt_count);
  const claim=await query.select('user_id').maybeSingle();if(claim.error)throw claim.error;if(!claim.data)continue;
  const save=async values=>{const result=await db.from(TABLE).update(values).eq('guild_id',GUILD_ID)
   .eq('user_id',row.user_id).eq('billing_month',row.billing_month).eq('attempted_at',stamp);
   if(result.error)throw result.error;};
  try{
   await guild.members.fetch(row.user_id);
   const user=await client.users.fetch(row.user_id),channel=await user.createDM();
   const payload=buildMonthlyCouponNotice(row),marker=`月領發放編號：${row.billing_month}:${row.user_id}`;
   let existing,before;
   if(row.attempt_count>0){
    for(let page=0;page<50;page++){
     const messages=await channel.messages.fetch({limit:100,...(before?{before}:{})});
     existing=messages.find(x=>x.author?.id===client.user.id&&x.content?.endsWith(marker));
     if(existing||messages.size<100)break;
     before=messages.last().id;
     if(page===49)throw Error('通知歷史尚未查完，暫緩補寄避免重複');
    }
   }
   const message=existing||await channel.send(payload);
   await save({notification_status:'sent',dm_channel_id:channel.id,dm_message_id:message.id,
    sent_at:new Date(message.createdTimestamp||Date.now()).toISOString(),last_error:null});sent++;
  }catch(error){
   const status=Number(error.code)===10007?'left':[50007,10013].includes(Number(error.code))?'blocked':'failed';
   await save({notification_status:status,last_error:String(error.message||error).slice(0,300)});
  }
 }
 return{scheduled:true,granted,sent,grantFailed};
}
function startMonthlyCouponScheduler(db,client,createNonOverlappingTask){
 const run=createNonOverlappingTask('VIP 每月優惠券發放與私訊',()=>processMonthlyCoupons(db,client));
 const timer=setInterval(run,60000);timer.unref?.();void run();return timer;
}
module.exports={GUILD_ID,FIRST_MONTH,monthlyCouponEligibility,buildMonthlyCouponNotice,processMonthlyCoupons,startMonthlyCouponScheduler};
