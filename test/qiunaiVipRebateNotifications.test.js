const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taipeiPeriod,rebateEligibility,buildRebateReminder,parseChoice,handleRebateChoice,processVipRebateNotifications } = require('../events/qiunaiVipRebateNotifications');
test('首日排程採台灣時區，跨年跨月正確', () => {
  assert.deepEqual(taipeiPeriod(new Date('2026-10-31T16:00:00Z')),{month:'2026-11-01',day:1});
  assert.deepEqual(taipeiPeriod(new Date('2026-12-31T16:00:00Z')),{month:'2027-01-01',day:1});
  assert.equal(taipeiPeriod(new Date('2026-10-31T15:59:59Z')).day,31);
});
test('低階不可選週返利，邀請級別延續既有首充資格', () => {
  assert.equal(rebateEligibility('vip5').eligible,false);
  assert.deepEqual(rebateEligibility('vip6'),{eligible:true,weekly:false,monthlyRate:2});
  assert.equal(buildRebateReminder('123','2026-11-01','vip7').components[0].components.length,1);
  for (const key of ['vip8','vvip1','evip','exclusive']) {
    const message=buildRebateReminder('123','2026-11-01',key);
    assert.equal(message.components[0].components.length,2);
    assert.match(message.content,/3%/);assert.match(message.content,/消費點數/);
  }
  assert.throws(()=>buildRebateReminder('123','2026-11-01','vip5'),/資格/);
});
test('按鈕限制本人及當月，固定 nonce 防重送', () => {
  const id='qrebate:2026-11-01:123:weekly', now=new Date('2026-11-01T01:00:00Z');
  assert.deepEqual(parseChoice(id,'123',now),{month:'2026-11-01',plan:'weekly'});
  assert.throws(()=>parseChoice(id,'456',now),/只有/);
  assert.throws(()=>parseChoice(id,'123',new Date('2026-12-01')),/過期/);
  assert.throws(()=>parseChoice('qrebate:2026-11-01:123:other','123',now),/只有/);
  assert.equal(buildRebateReminder('123','2026-11-01','vip8').nonce,buildRebateReminder('123','2026-11-01','vip8').nonce);
  assert.notEqual(buildRebateReminder('123','2026-11-01','vip8').nonce,buildRebateReminder('123','2026-12-01','vip8').nonce);
});
test('非一號不排隊也不私訊', async () => {
  const result=await processVipRebateNotifications({from(){throw Error('不得查詢');}}, {},new Date('2026-10-16'));
  assert.deepEqual(result,{scheduled:false,sent:0});
});
test('資料庫拒絕切換不回報成功', async () => {
  let reply;
  const {month}=taipeiPeriod();
  await handleRebateChoice({customId:`qrebate:${month}:123:weekly`,user:{id:'123'},deferred:true,
    editReply:async x=>{reply=x.content;}},{rpc:async()=>({error:{message:'本月已使用首充返利，次月才能更換方案'}})});
  assert.match(reply,/❌.*次月/);
});

function notificationDb(users) {
  const tables={user_vips:users,qiunai_vip_rebate_notifications:[]};
  return { tables, from(table) {
    let values,kind='read', filters=[];
    const q={select(){return q;},eq(k,v){filters.push(x=>x[k]===v);return q;},
      is(k,v){filters.push(x=>(x[k]??null)===v);return q;},in(k,v){filters.push(x=>v.includes(x[k]));return q;},
      lt(k,v){filters.push(x=>x[k]<v);return q;},maybeSingle(){q.single=true;return q;},
      update(v){kind='update';values=v;return q;},upsert(v){kind='upsert';values=v;return q;},
      then(resolve,reject){try{
        const all=tables[table];
        if(kind==='upsert'){for(const v of values)if(!all.some(x=>x.user_id===v.user_id&&x.billing_month===v.billing_month))all.push({...v,status:'pending',attempt_count:0,attempted_at:null});return Promise.resolve({data:null,error:null}).then(resolve,reject);}
        const rows=all.filter(x=>filters.every(f=>f(x)));
        if(kind==='update')rows.forEach(x=>Object.assign(x,values));
        const snapshot=rows.map(x=>({...x}));
        return Promise.resolve({data:q.single?snapshot[0]||null:snapshot,error:null}).then(resolve,reject);
      }catch(e){return Promise.reject(e).then(resolve,reject);}}};return q;
  }};
}
test('一號寄送、重啟去重、關閉私訊及退群均留下狀態', async () => {
  const db=notificationDb(['ok','blocked','left'].map(user_id=>({user_id,level_key:'vip8',guild_id:'1206138511535898654'})));
  let sends=0;
  const client={user:{id:'bot'},guilds:{fetch:async()=>({members:{fetch:async id=>{if(id==='left')throw Object.assign(Error('退群'),{code:10007});}}})},
    users:{fetch:async id=>({createDM:async()=>({id:'dm',send:async payload=>{
      if(id==='blocked')throw Object.assign(Error('無法私訊'),{code:50007});
      sends++;assert.equal(payload.components[0].components.length,2);
      return {id:'message',createdAt:new Date()};
    }})})}};
  const now=new Date('2026-11-01T01:00:00Z');
  await processVipRebateNotifications(db,client,now);
  await processVipRebateNotifications(db,client,now);
  assert.equal(sends,1);
  assert.deepEqual(db.tables.qiunai_vip_rebate_notifications.map(x=>x.status),['sent','blocked','left']);
});
test('寄出後資料庫寫入前中斷，可找回 Discord 訊息而不重發',async()=>{
  const db=notificationDb([{user_id:'123',level_key:'vip8',guild_id:'1206138511535898654'}]);
  db.tables.qiunai_vip_rebate_notifications.push({user_id:'123',billing_month:'2026-11-01',status:'sending',attempt_count:1,attempted_at:'2026-11-01T00:00:00Z'});
  const payload=buildRebateReminder('123','2026-11-01','vip8');
  const existing={id:'previous',author:{id:'bot'},content:payload.content,createdAt:new Date('2026-11-01T00:00:00Z')};
  const client={user:{id:'bot'},guilds:{fetch:async()=>({members:{fetch:async()=>({})}})},users:{fetch:async()=>({createDM:async()=>({id:'dm',messages:{fetch:async()=>[existing]},send:async()=>{throw Error('不應重發');}})})}};
  await processVipRebateNotifications(db,client,new Date('2026-11-01T01:00:00Z'));
  assert.equal(db.tables.qiunai_vip_rebate_notifications[0].dm_message_id,'previous');
  assert.equal(db.tables.qiunai_vip_rebate_notifications[0].status,'sent');
});
