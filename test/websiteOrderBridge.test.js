const test=require('node:test'),assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {Readable}=require('node:stream');
const {authenticate,validPayload,createWebsiteOrderBridge}=require('../utils/websiteOrderBridge');
const value={requestId:'WEB-00000000-0000-4000-8000-000000000001',userId:'1024589023144058902',requirements:{customerName:'測試',game:'特戰英豪',serviceType:'娛樂',quantity:'2小時',platform:'電腦',targetRank:'不指定',companionRank:'不指定',companionCount:1,notes:''}};
function request(body,patch={}){
 const req=Readable.from([body]);req.method='POST';req.url='/website/orders';
 const time=String(Date.now());req.headers={'x-website-time':time,'x-website-signature':createHmac('sha256','test-key').update(`qiunai-website-v1\n${time}\nPOST\n/website/orders\n${body}`).digest('hex')};Object.assign(req,patch);return req;
}
function dbMock(){const rows=[];return {rows,from(){const filters=[];let op='select',changes;
 const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(){return q;},gt(){return q;},neq(){return q;},order(){return q;},limit(){return q;},
 insert(v){op='insert';changes=v;return q;},update(v){op='update';changes=v;return q;},maybeSingle(){return q.then(r=>({...r,data:r.data?.[0]||null}));},
 then(resolve,reject){let result;if(op==='insert'){if(rows.some(r=>r.flow_id===changes.flow_id))result={error:{code:'23505'}};else{rows.push({...changes});result={data:null};}}
 else{const matched=rows.filter(r=>filters.every(f=>f(r)));if(op==='update')matched.forEach(r=>Object.assign(r,changes));result={data:matched.map(r=>structuredClone(r))};}return Promise.resolve(result).then(resolve,reject);}};return q;}};}
test('簽章綁定時間、方法、路徑與完整需求內容',()=>{
 const body=JSON.stringify(value),req=request(body);assert.equal(authenticate(req,body,'test-key'),true);
 assert.equal(authenticate(req,body+' ','test-key'),false);assert.equal(authenticate(req,body,'wrong-key'),false);
 assert.equal(authenticate(req,body,'test-key',Date.now()+120000),false);
 req.url+='/other';assert.equal(authenticate(req,body,'test-key'),false);
});
test('拒絕不完整需求、偽造會員與超額人數',()=>{
 assert.equal(!!validPayload(value),true);
 for(const patch of [{userId:'x'},{requestId:'x'},{requirements:{...value.requirements,companionCount:9}},{requirements:{...value.requirements,notes:'x'.repeat(501)}}])assert.equal(!!validPayload({...value,...patch}),false);
});
test('重試同一官網需求只保存一張，不允許更換會員',async()=>{
 const db=dbMock(),bridge=createWebsiteOrderBridge({db,client:{},token:'test-key',createOrder:async()=>{throw Error('HTTP不應直接開區');}});
 async function post(data){let result,status;await bridge.handleHttpRequest(request(JSON.stringify(data)),{writeHead(s){status=s;},end(v){result=JSON.parse(v);}});return{status,result};}
 assert.equal((await post(value)).status,200);assert.equal((await post(value)).status,200);assert.equal(db.rows.length,1);
 assert.equal((await post({...value,userId:'847840193859682304'})).status,409);
});
test('未驗簽與非官網路徑不觸及資料庫',async()=>{
 const bridge=createWebsiteOrderBridge({db:{from(){throw Error('不可讀寫');}},client:{},token:'test-key'});let status;
 assert.equal(await bridge.handleHttpRequest(request('{}',{url:'/other'}),{}),false);
 await bridge.handleHttpRequest(request('{}',{headers:{}}),{writeHead(s){status=s;},end(){}});assert.equal(status,401);
});
test('未加入時保留需求，加入後可重試；完成後不重開',async()=>{
 const db=dbMock();db.rows.push({organization_code:'qiunai:website-orders',flow_id:value.requestId,payload:{...value,status:'queued'},revision:1,expires_at:new Date(Date.now()+86400000).toISOString()});
 let joined=false,calls=0;
 const bridge=createWebsiteOrderBridge({db,client:{},token:'test-key',createOrder:async()=>{calls++;return joined?{channelId:'channel',orderId:'order'}:null;}});
 await bridge.recover();assert.equal(db.rows[0].payload.status,'waiting_member');joined=true;
 await bridge.recover();assert.equal(db.rows[0].payload.status,'opened');
 // Production query excludes opened rows; processRow also guards against reopening.
 await bridge.recover();assert.equal(calls,2);
});
