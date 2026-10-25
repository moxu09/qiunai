const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EmbedBuilder}=require('discord.js');
const {sendVipChannelDelivery,rewardDeliveryKey}=require('../utils/vipChannelDelivery');
const reward={guild_id:'1206138511535898654',user_id:'123',level_key:'vip0'};
function fixture({existing=null,sendError=null,guild=reward.guild_id}={}){
  let saved=null,sends=0;
  const supabase={from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:saved,error:null}),upsert:async v=>{saved=v;return {error:null};}};return q;}};
  const channel={guildId:guild,isTextBased:()=>true,messages:{fetch:async()=>existing?[existing]:[]},send:async payload=>{sends++;if(sendError)throw sendError;assert.deepEqual(payload.allowedMentions.users,['123']);return {id:'sent'};}};
  const client={user:{id:'bot'},channels:{fetch:async()=>channel}};
  return {supabase,client,reward,channelId:'order-channel',embed:new EmbedBuilder().setTitle('測試'),get saved(){return saved;},get sends(){return sends;}};
}
test('頻道播報成功留下訊息紀錄，重試不重播',async()=>{
  const f=fixture();await sendVipChannelDelivery(f);await sendVipChannelDelivery(f);
  assert.equal(f.sends,1);assert.equal(f.saved.message_id,'sent');
});
test('Discord 已送出但尚未寫入，依福利鍵找回',async()=>{
  const f=fixture({existing:{id:'previous',author:{id:'bot'},embeds:[{footer:{text:'VIP:'+rewardDeliveryKey(reward)}}]}});
  await sendVipChannelDelivery(f);assert.equal(f.sends,0);assert.equal(f.saved.message_id,'previous');
});
test('頻道送出錯誤必須拋出，不得假裝完成',async()=>{
  const f=fixture({sendError:Error('Missing permissions')});
  await assert.rejects(sendVipChannelDelivery(f),/Missing permissions/);assert.equal(f.saved,null);
});
test('不得將秋奈會員福利送到別的組織',async()=>{
  const f=fixture({guild:'deepnight'});await assert.rejects(sendVipChannelDelivery(f),/不屬於秋奈/);assert.equal(f.sends,0);
});
test('無訂單頻道或指定消費福利頻道改私訊本人並記錄去重',async()=>{
 for(const channelId of [undefined,'1313770637587644507']){
  const f=fixture();f.channelId=channelId;let dms=0;
  f.client.channels.fetch=async()=>{throw Error('不得讀取福利頻道');};
  f.client.users={fetch:async id=>{assert.equal(id,'123');return {createDM:async()=>({id:'private-dm',messages:{fetch:async()=>[]},send:async()=>{dms++;return{id:'dm-message'};}})};}};
  await sendVipChannelDelivery(f);await sendVipChannelDelivery(f);
  assert.equal(dms,1);assert.equal(f.saved.channel_id,'private-dm');
  assert.equal(f.sends,0);
 }
});
test('原頻道已刪除改私訊，Discord 暫時故障不盲目改投',async()=>{
 const f=fixture();f.client.channels.fetch=async()=>{throw Object.assign(Error('Unknown Channel'),{code:10003});};
 f.client.users={fetch:async()=>({createDM:async()=>({id:'dm',messages:{fetch:async()=>[]},send:async()=>({id:'dm-sent'})})})};
 await sendVipChannelDelivery(f);assert.equal(f.saved.channel_id,'dm');
 const transient=fixture();transient.client.channels.fetch=async()=>{throw Error('Network timeout');};
 await assert.rejects(sendVipChannelDelivery(transient),/Network timeout/);assert.equal(transient.saved,null);
});
test('私訊被關閉不標完成，已送出私訊但未寫入時找回原訊息',async()=>{
 const f=fixture();f.channelId=null;
 f.client.users={fetch:async()=>({createDM:async()=>({id:'dm',messages:{fetch:async()=>[]},send:async()=>{throw Object.assign(Error('Cannot send messages'),{code:50007});}})})};
 await assert.rejects(sendVipChannelDelivery(f),/Cannot send/);assert.equal(f.saved,null);
 f.client.users.fetch=async()=>({createDM:async()=>({id:'dm',messages:{fetch:async()=>[{id:'old-dm',author:{id:'bot'},embeds:[{footer:{text:'VIP:'+rewardDeliveryKey(reward)}}]}]},send:async()=>{throw Error('不得重寄');}})});
 await sendVipChannelDelivery(f);assert.equal(f.saved.message_id,'old-dm');
});
test('背景重試使用持久化的原訂單頻道，不被新呼叫覆寫',async()=>{
 const f=fixture();f.reward={...reward,notification_channel_id:'original-order'};
 let destination;const fetch=f.client.channels.fetch;f.client.channels.fetch=async id=>{destination=id;return fetch(id);};
 await sendVipChannelDelivery(f);assert.equal(destination,'original-order');assert.equal(f.saved.channel_id,'original-order');
});
