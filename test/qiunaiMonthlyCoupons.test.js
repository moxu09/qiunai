const test=require('node:test'),assert=require('node:assert/strict');
const {Collection}=require('discord.js');
const {monthlyCouponEligibility,buildMonthlyCouponNotice,processMonthlyCoupons,GUILD_ID}=require('../events/qiunaiMonthlyCoupons');
function fixture({blocked=false,saveFails=false,left=false}={}){
 const rows=[],messages=new Collection();let items=0,sends=0,rpcs=0,fail=saveFails;
 const members=[{user_id:'111111111111111111',guild_id:GUILD_ID,level_key:'vip8'},{user_id:'222222222222222222',guild_id:GUILD_ID,level_key:'vip9'},
 {user_id:'333333333333333333',guild_id:'other',level_key:'vip8'}];
 const db={from(table){let filters=[],change=null,one=false;const q={select(){return q;},eq(k,v){filters.push(x=>x[k]===v);return q;},in(k,v){filters.push(x=>v.includes(x[k]));return q;},lt(k,v){filters.push(x=>x[k]<v);return q;},order(){return q;},range(){return q;},update(v){change=v;return q;},maybeSingle(){one=true;return q;},
 then(ok,no){let data=(table==='user_vips'?members:rows).filter(x=>filters.every(f=>f(x)));
 if(change?.notification_status==='sent'&&fail){fail=false;return Promise.reject(Error('save unavailable')).then(ok,no);}
 if(change)data.forEach(x=>Object.assign(x,change));return Promise.resolve({data:one?data[0]||null:data,error:null}).then(ok,no);}};return q;},
 async rpc(_,p){rpcs++;let row=rows.find(x=>x.user_id===p.p_user_id&&x.billing_month===p.p_billing_month);if(row)return {data:{...row,granted:true,already_granted:true}};
 row={user_id:p.p_user_id,guild_id:GUILD_ID,billing_month:p.p_billing_month,item_name:'95折優惠券',coupon_count:3,notification_status:'pending',attempt_count:0,attempted_at:null};rows.push(row);items+=3;return {data:{...row,granted:true,already_granted:false}};}};
 const client={user:{id:'bot'},guilds:{fetch:async()=>({members:{fetch:async()=>{if(left)throw Object.assign(Error('left'),{code:10007});return {};}}})},users:{fetch:async()=>({createDM:async()=>({id:'dm',messages:{fetch:async()=>messages},send:async p=>{if(blocked)throw Object.assign(Error('blocked'),{code:50007});sends++;const m={id:'m1',author:{id:'bot'},content:p.content,createdTimestamp:Date.parse('2026-10-31T16:00:00Z')};messages.set(m.id,m);return m;}})})}};
 return{db,client,rows,get items(){return items;},get sends(){return sends;},get rpcs(){return rpcs;}};
}
test('只依公告明列vip8，首充及一次性福利不算月領券',()=>{
 assert.equal(monthlyCouponEligibility('vip8'),true);for(const key of ['vip7','vip9','vvip1',null])assert.equal(monthlyCouponEligibility(key),false);
 const p=buildMonthlyCouponNotice({user_id:'111',billing_month:'2026-11-01',item_name:'95折優惠券',coupon_count:3});
 assert.match(p.content,/3 張/);assert.match(p.content,/500元/);assert.match(p.content,/每筆消費限用一張/);assert.equal(p.enforceNonce,true);
});
test('10月及非1日完全不查資料或發券；台北11月1日零點觸發',async()=>{
 for(const date of ['2026-10-01T00:00:00Z','2026-10-16T00:00:00Z','2026-10-31T15:59:59Z','2026-11-01T16:00:00Z'])assert.equal((await processMonthlyCoupons({}, {},new Date(date))).scheduled,false);
 const f=fixture();const result=await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:00:00Z'));
 assert.equal(result.granted,1);assert.equal(result.sent,1);assert.equal(f.items,3);assert.equal(f.rows.length,1);
});
test('同月重啟重跑不重發券、不重寄通知',async()=>{
 const f=fixture();await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:00:00Z'));
 await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:06:00Z'));assert.equal(f.items,3);assert.equal(f.sends,1);
});
test('私訊被關閉仍發到背包，記錄blocked，不重新發券',async()=>{
 const f=fixture({blocked:true});await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:00:00Z'));
 assert.equal(f.items,3);assert.equal(f.rows[0].notification_status,'blocked');
 await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:06:00Z'));assert.equal(f.items,3);
});
test('Discord成功後資料庫保存失敗：依歷史找回而不再寄一份',async()=>{
 const f=fixture({saveFails:true});await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:00:00Z'));
 assert.equal(f.rows[0].notification_status,'failed');
 await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:06:00Z'));
 assert.equal(f.items,3);assert.equal(f.sends,1);assert.equal(f.rows[0].notification_status,'sent');
});
test('已離群者不新發券',async()=>{
 const f=fixture({left:true});await processMonthlyCoupons(f.db,f.client,new Date('2026-10-31T16:00:00Z'));
 assert.equal(f.items,0);assert.equal(f.rpcs,0);
});
