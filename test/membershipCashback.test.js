const test=require('node:test');
const assert=require('node:assert/strict');
const { completionMessage, getPointSummary, getCashbackEstimate, createCashbackNotifier, GUILD_ID }=require('../utils/membershipCashback');
const { receiptSvg, buildOrderReceiptData }=require('../utils/receiptImages');
test('收據顯示預計點數，舊格式不受影響',()=>{
  const data=buildOrderReceiptData({order:{id:'a'},payerName:'客人',playerNames:['陪陪'],amount:100,estimatedPoints:3});
  assert.match(receiptSvg(data),/預計獲得消費點數：3 點/);
  assert.doesNotMatch(receiptSvg({...data,estimatedPoints:undefined}),/預計獲得/);
  assert.match(receiptSvg({...data,estimatedPoints:0}),/預計獲得消費點數：0 點/);
});
test('實際通知使用入帳紀錄並明示欠點抵扣，不當作錢包',()=>{
  const msg=completionMessage({id:'order',order_no:'Q123'},{points:10,debt_repaid:3});
  assert.match(msg,/本筆實際入帳 7 點/);assert.match(msg,/抵扣先前退單欠點 3/);
  assert.match(msg,/<#1513531969315537096>/);assert.ok(msg.endsWith('回饋編號：order'));
});
function dbFor(tables, seen=[]){return{from(table){const filters=[];const q={};let limit=Infinity;
  for(const name of ['select','order'])q[name]=()=>q;
  q.limit=n=>{limit=n;return q;};
  q.or=expression=>{filters.push(x=>expression.split(',').some(term=>x.operation_key?.startsWith(term.replace('operation_key.like.','').replace('%',''))));return q;};
  q.eq=(key,val)=>{filters.push(x=>x[key]===val);seen.push([table,key,val]);return q;};
  q.maybeSingle=async()=>({data:(tables[table]||[]).filter(x=>filters.every(f=>f(x)))[0]||null});
  q.then=(resolve,reject)=>Promise.resolve({data:(tables[table]||[]).filter(x=>filters.every(f=>f(x))).slice(0,limit)}).then(resolve,reject);
  return q;
}};}
test('本人查詢所有資料均以本人 ID 篩選',async()=>{
  const seen=[];const db=dbFor({qiunai_vip_point_accounts:[{user_id:'me',balance:7},{user_id:'other',balance:999}],qiunai_vip_point_logs:[]},seen);
  const text=await getPointSummary(db,'me');assert.match(text,/目前可用：7 點/);assert.doesNotMatch(text,/999/);
  assert.equal(seen.filter(x=>x[1]==='user_id'&&x[2]==='me').length,2);
});
test('人工發送的小數回饋出現在本人最近十筆明細',async()=>{
  const text=await getPointSummary(dbFor({qiunai_vip_point_accounts:[{user_id:'me',balance:12.34}],qiunai_vip_point_logs:[
    {user_id:'me',operation_key:'manual-cashback:123',amount:12.34,note:'人工回饋：補登',created_at:'2026-10-19T02:00:00Z'},
    {user_id:'other',operation_key:'manual-cashback:456',amount:99,note:'其他人',created_at:'2026-10-19T02:00:00Z'}
  ]}),'me');
  assert.match(text,/人工回饋｜\+12.34 點/);assert.doesNotMatch(text,/其他人/);
});
test('收據優先採用既有發放紀錄；退款為零、異店不查',async()=>{
  const order={id:'a',guild_id:GUILD_ID};
  assert.equal(await getCashbackEstimate(dbFor({qiunai_membership_cashbacks:[{order_id:'a',points:6}]}),order),6);
  assert.equal(await getCashbackEstimate(dbFor({qiunai_membership_cashbacks:[{order_id:'a',points:6,reversed_at:'now'}]}),order),0);
  assert.equal(await getCashbackEstimate({from(){throw Error('不可跨店');}},{...order,guild_id:'other'}),null);
});
test('未完成、未付款、退款、異店與帳號不符都不能通知或再發點',async()=>{
  for(const patch of [{status:'pending'},{paid:false},{guild_id:'other'},{customer_id:'other'},{is_deleted:true}]){
    const db=dbFor({qiunai_membership_cashbacks:[{order_id:'a',user_id:'u',points:5}],play_orders:[{id:'a',customer_id:'u',guild_id:GUILD_ID,status:'completed',paid:true,...patch}]});
    assert.equal(await createCashbackNotifier(db,{users:{fetch(){throw Error('不能發送');}}}).notify('a'),false);
  }
  const db=dbFor({qiunai_membership_cashbacks:[{order_id:'a',reversed_at:'now'}]});
  assert.equal(await createCashbackNotifier(db,{}).notify('a'),false);
});
test('查詢錯誤不得偽裝成零點',async()=>{
  const db={from(){return{select(){return this;},eq(){return this;},or(){return this;},maybeSingle:async()=>({error:Error('offline')}),order(){return this;},limit:async()=>({error:Error('offline')})};}};
  await assert.rejects(getPointSummary(db,'me'),/offline/);
});
test('最近十筆只列回饋，包含首充與零點，不混入扣點或別人的明細',async()=>{
  const logs=[{user_id:'me',operation_key:'checkout:other',amount:-50},
    {user_id:'other',operation_key:'membership-cashback:private',note:'別人的秘密',amount:100},
    ...Array.from({length:12},(_,i)=>({user_id:'me',operation_key:`membership-${i===1?'topup':'cashback'}:${i}`,amount:i,created_at:'2026-10-16T02:00:00Z',note:`回饋明細${i}`}))];
  const text=await getPointSummary(dbFor({qiunai_vip_point_accounts:[{user_id:'me',balance:123}],qiunai_vip_point_logs:logs}),'me');
  assert.match(text,/目前可用：123 點/);assert.match(text,/最近十筆回饋/);
  assert.match(text,/10\. /);assert.doesNotMatch(text,/11\. |回饋明細10|別人的秘密|-50/);
  assert.match(text,/消費回饋｜0 點/);assert.match(text,/首充返利｜\+1 點/);
  assert.ok(text.length<2000);
});
test('成功通知持久化去重；Discord 成功但保存失敗時依歷史找回',async()=>{
  const {Collection}=require('discord.js');
  const db=dbFor({qiunai_membership_cashbacks:[{order_id:'a',user_id:'u',points:8,debt_repaid:0}],play_orders:[{id:'a',customer_id:'u',guild_id:GUILD_ID,status:'completed',paid:true}]});
  let closed=false, failSave=true, sends=0;
  const store={claim:async()=>closed?null:{id:'a'},finish:async(_,status)=>{if(status==='sent'&&failSave){failSave=false;throw Error('db temporarily offline');}closed=status==='sent';}};
  const messages=new Collection();
  const channel={messages:{fetch:async()=>messages},send:async p=>{sends++;const m={id:'dm1',content:p.content,author:{id:'bot'}};messages.set(m.id,m);return m;}};
  const notifier=createCashbackNotifier(db,{user:{id:'bot'},users:{fetch:async()=>({createDM:async()=>channel})}},{error(){}},store);
  assert.equal(await notifier.notify('a'),false);
  assert.equal(await notifier.notify('a'),true);
  assert.equal(await notifier.notify('a'),false);
  assert.equal(sends,1);assert.equal(closed,true);
});
test('私訊被封鎖會記錄，不影響點數，也不無限重寄',async()=>{
  const db=dbFor({qiunai_membership_cashbacks:[{order_id:'a',user_id:'u',points:8}],play_orders:[{id:'a',customer_id:'u',guild_id:GUILD_ID,status:'completed',paid:true}]});
  let status;
  const store={claim:async()=>({}),finish:async(_,s)=>{status=s;}};
  const notifier=createCashbackNotifier(db,{users:{fetch:async()=>{throw Object.assign(Error('blocked'),{code:50007});}}},{error(){}},store);
  assert.equal(await notifier.notify('a'),false);assert.equal(status,'dm_blocked');
});
