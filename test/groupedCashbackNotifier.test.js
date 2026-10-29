const test=require('node:test');
const assert=require('node:assert/strict');
const {Collection}=require('discord.js');
const {snapshot,groupMessage,createGroupedCashbackNotifier}=require('../utils/groupedCashbackNotifier');
function harness(){
 const order={guild_id:'g',customer_id:'u',order_group_id:'checkout'};
 const tables={play_orders:[{...order,id:'a',order_type:'打賞',paid:true,status:'completed',assigned_player:'p1',created_at:'2026-01-01T00:00:00Z'},
 {...order,id:'b',order_type:'打賞',paid:true,status:'completed',assigned_player:'p2',created_at:'2026-01-01T00:00:00Z'}],
 qiunai_membership_cashbacks:[{order_id:'a',user_id:'u',points:0.33,debt_repaid:0},{order_id:'b',user_id:'u',points:0.66,debt_repaid:0.1}],bot_service_order_flows:[]};
 let failSave=false;
 const db={from(name){let filters=[],mode='read',values; const q={select:()=>q,eq:(k,v)=>{filters.push(r=>r[k]===v);return q;},in:(k,v)=>{filters.push(r=>v.includes(r[k]));return q;},insert:v=>{mode='insert';values=v;return q;},update:v=>{mode='update';values=v;return q;}};
 function execute(single){let rows=tables[name].filter(r=>filters.every(f=>f(r)));
 if(mode==='insert'){if(tables[name].some(r=>r.organization_code===values.organization_code&&r.flow_id===values.flow_id)) return {error:{code:'23505'}};tables[name].push({...values,revision:1});rows=[];}
 if(mode==='update'){if(failSave&&values.payload?.status==='sent'){failSave=false;return{error:Error('save failed')};}rows.forEach(r=>Object.assign(r,values));}
 return{data:single?rows[0]||null:rows};}
 q.single=q.maybeSingle=async()=>execute(true);q.then=(a,b)=>Promise.resolve(execute(false)).then(a,b);return q;}};
 const messages=new Collection();let sends=0,edits=0;
 const channel={messages:{fetch:async arg=>{if(typeof arg==='string'){if(!messages.has(arg))throw Object.assign(Error('deleted'),{code:10008});return messages.get(arg);}return messages;}},send:async p=>{sends++;const m={id:'dm'+sends,content:p.content,author:{id:'bot'},edit:async p=>{edits++;m.content=p.content;}};messages.set(m.id,m);return m;}};
 const client={user:{id:'bot'},users:{fetch:async()=>({createDM:async()=>channel})}};
 return{order,tables,messages,notify:createGroupedCashbackNotifier(db,client,{error(){}}),stats:()=>({sends,edits}),failSave:()=>{failSave=true;}};
}
test('合計只算有效回饋並準確處理小數及欠點',()=>{
 const h=harness();h.tables.play_orders.push({id:'deleted',paid:true,status:'completed',is_deleted:true});
 const data=snapshot(h.tables.play_orders,[...h.tables.qiunai_membership_cashbacks,{order_id:'deleted',points:100},{order_id:'other',points:999}]);
 assert.equal(data.points,0.99);assert.equal(data.debt,0.1);assert.match(groupMessage(data,'marker'),/實際入帳 0.89 點/);assert.equal(data.recipients,2);
});
test('多人一則，重試不重寄；晚到明細編輯原通知',async()=>{
 const h=harness();assert.equal(await h.notify(h.order),true);assert.equal(await h.notify(h.order),false);
 h.tables.play_orders.push({...h.tables.play_orders[0],id:'c'});h.tables.qiunai_membership_cashbacks.push({order_id:'c',user_id:'u',points:1});
 assert.equal(await h.notify(h.order),true);assert.deepEqual(h.stats(),{sends:1,edits:1});assert.match(h.messages.first().content,/共 1.99 點/);
});
test('送出後保存失敗，重試找回同一則；同組併行只一則',async()=>{
 const h=harness();h.failSave();assert.equal(await h.notify(h.order),false);
 assert.equal(await h.notify(h.order),true);assert.equal(h.stats().sends,1);
 const j=harness();await Promise.all([j.notify(j.order),j.notify(j.order)]);assert.equal(j.stats().sends,1);
});
test('逐筆已通知的舊單不補發；未結算與他人資料不混入',async()=>{
 const h=harness();for(const id of ['a','b'])h.tables.bot_service_order_flows.push({organization_code:'qiunai:cashback-notifications:receipts',flow_id:'cashback-completed:'+id,closed_at:'now',payload:{status:'sent',messageId:'old'}});
 assert.equal(await h.notify(h.order),false);assert.equal(h.stats().sends,0);
 const j=harness();j.tables.play_orders[0].created_at=new Date().toISOString();assert.equal(await j.notify(j.order),false);assert.equal(j.stats().sends,0);
});
