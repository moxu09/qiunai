const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const {createRedPacketExpiry,RED_PACKET_LIFETIME_MS}=require('../utils/redPacketExpiry');
function harness({packets=[],dmError=null,failOnce=false}={}){
 const state=packets.map(p=>({...p})),calls={refunds:0,rpcs:0,dm:[],edits:[],errors:[],adopted:[]};let balance=100,attempts=0;
 const db={from(table){assert.equal(table,'red_packets');const filters=[];let patch,limit=Infinity;
  const q={select:()=>q,eq:(k,v)=>{filters.push(p=>p[k]===v);return q;},is:(k,v)=>{filters.push(p=>(p[k]??null)===v);return q;},not:(k,op,v)=>{assert.equal(op,'is');filters.push(p=>(p[k]??null)!==v);return q;},lte:(k,v)=>{filters.push(p=>p[k]!=null&&p[k]<=v);return q;},order:()=>q,limit:n=>{limit=n;return q;},update:p=>{patch=p;return q;},then(resolve,reject){try{const rows=state.filter(p=>filters.every(f=>f(p))).slice(0,limit);if(patch)for(const p of rows){Object.assign(p,patch);if(patch.organization_code==='qiunai'){p.expires_at=new Date(Date.parse(p.created_at)+RED_PACKET_LIFETIME_MS).toISOString();calls.adopted.push(p.id);}}return Promise.resolve({data:rows.map(p=>({...p})),error:null}).then(resolve,reject);}catch(e){return Promise.reject(e).then(resolve,reject);}}};return q;},
 async rpc(name,{p_packet_id:id}){assert.equal(name,'qiunai_expire_red_packet');calls.rpcs++;const p=state.find(p=>p.id===id);if(p.expired_at)return{data:{refunded:false}};p.expired_at=new Date().toISOString();p.status='cancelled';p.refunded_amount=p.remaining_amount;p.remaining_amount=0;p.remaining_count=0;balance+=p.refunded_amount;p.refund_balance=balance;calls.refunds++;return{data:{refunded:true}};}};
 const client={channels:{fetch:async id=>({guildId:id==='other'?'other-guild':'qiunai-guild',messages:{fetch:async()=>({embeds:[],edit:async p=>calls.edits.push(p)})}})},users:{fetch:async()=>({send:async p=>{calls.dm.push(p);attempts++;if(dmError&&(!failOnce||attempts===1))throw Object.assign(Error('DM failure'),{code:dmError});}})}};
 const make=()=>createRedPacketExpiry({supabase:db,client,guildId:'qiunai-guild',logger:{error:(...a)=>calls.errors.push(a)}});
 return{calls,state,make,service:make(),get balance(){return balance;}};
}
const expired=()=>({id:1,packet_no:'RP-TEST',sender_id:'sender',organization_code:'qiunai',status:'active',remaining_amount:30,remaining_count:2,channel_id:'qiunai',message_id:'msg',created_at:new Date(Date.now()-25*3600_000).toISOString(),expires_at:new Date(Date.now()-3600_000).toISOString(),expired_at:null,expiry_notified_at:null});
test('24小時未領餘額退回，公開紅包關閉按鈕、私人餘額只出現在私訊',async()=>{
 assert.equal(RED_PACKET_LIFETIME_MS,86400000);const h=harness({packets:[expired()]});await h.service.run();
 assert.equal(h.balance,130);assert.equal(h.calls.refunds,1);assert.equal(h.calls.edits.length,1);assert.equal(h.calls.edits[0].components.length,0);
 const pub=JSON.stringify(h.calls.edits[0]);assert.match(pub,/30 星雨幣/);assert.doesNotMatch(pub,/130|餘額：/);
 assert.match(JSON.stringify(h.calls.dm[0]),/退款後餘額：130/);assert.equal(h.calls.dm[0].enforceNonce,true);assert.ok(h.state[0].expiry_notified_at);
 await h.service.run();assert.equal(h.calls.refunds,1);assert.equal(h.calls.dm.length,1);
});
test('只處理到期秋奈紅包，不動其他店及未到期紅包',async()=>{
 const h=harness({packets:[expired(),{...expired(),id:2,organization_code:'deepnight'},{...expired(),id:3,expires_at:new Date(Date.now()+3600_000).toISOString()}]});await h.service.run();assert.equal(h.calls.rpcs,1);assert.equal(h.state[1].status,'active');assert.equal(h.state[2].status,'active');
});
test('舊紅包需先確認發送頻道所屬秋奈，使用原發送時間計算',async()=>{
 const h=harness({packets:[{...expired(),organization_code:null,expires_at:null},{...expired(),id:2,organization_code:null,expires_at:null,channel_id:'other'}]});await h.service.run();assert.deepEqual(h.calls.adopted,[1]);assert.equal(h.calls.refunds,1);assert.equal(h.state[1].organization_code,null);
});
test('重啟補發到期狀態與私訊，不會再次退款',async()=>{
 const h=harness({packets:[{...expired(),status:'cancelled',expired_at:new Date().toISOString(),refunded_amount:30,refund_balance:130}]});await h.make().run();assert.equal(h.calls.rpcs,0);assert.equal(h.calls.refunds,0);assert.equal(h.calls.dm.length,1);
});
test('私訊被關閉仍完成退款與公開狀態，不會重複加錢',async()=>{
 for(const dmError of [50007,50278]){const h=harness({packets:[expired()],dmError});await h.service.run();await h.make().run();assert.equal(h.calls.refunds,1);assert.equal(h.calls.dm.length,1);assert.ok(h.state[0].expiry_notified_at);}
});
test('暫時性通知失敗可重試，沿用固定 nonce 且不再退錢',async()=>{
 const h=harness({packets:[expired()],dmError:503,failOnce:true});await h.service.run();assert.equal(h.state[0].expiry_notified_at,null);await h.make().run();assert.equal(h.calls.refunds,1);assert.equal(h.calls.dm.length,2);assert.equal(h.calls.dm[0].nonce,h.calls.dm[1].nonce);assert.ok(h.state[0].expiry_notified_at);
});
test('發送前先確認資料庫政策，所有領取走共用原子期限檢查',()=>{
 const src=fs.readFileSync(require.resolve('../index.js'),'utf8');const a=src.slice(src.indexOf('async function createRedPacket('),src.indexOf('async function claimRedPacket('));
 assert.ok(a.indexOf('qiunai_red_packet_expiry_ready')<a.indexOf('await changeCoins('));assert.match(a,/organization_code: "qiunai"/);assert.match(a,/發出24小時後/);assert.match(src,/redPacketExpiry\.start\(\)/);
 const claim=src.slice(src.indexOf('async function claimPreparedRedPacket('),src.indexOf('async function createRedPacket('));assert.match(claim,/qiunai_claim_red_packet/);
 const handler=src.slice(src.indexOf('async function claimRedPacket('),src.indexOf('async function createPrivateRoom('));assert.doesNotMatch(handler,/claim_red_packet_safe/);
});
