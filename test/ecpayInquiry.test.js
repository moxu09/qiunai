const test=require('node:test'),assert=require('node:assert/strict'),{createHmac}=require('node:crypto');
const {requestEcpayInquiry,handleEcpayInquiry,recoverPendingEcpayPayments,buildEcpayInquiryRow}=require('../utils/ecpayInquiry');
const payment={organization_code:'qiunai',user_id:'u',channel_id:'c'};
function db(rows,checks=[]){return {from(table){const data=table==='ecpay_service_inquiries'?checks:rows;const q={select(){return q},eq(){return q},gte(){return q},lte(){return q},order(){return q},in(){return q},limit(){return Promise.resolve({data,error:null})},maybeSingle(){return Promise.resolve({data,error:null})},then(resolve,reject){return Promise.resolve({data,error:null}).then(resolve,reject)}};return q}};}
test('查單按鈕使用私密回覆且驗證本人與頻道，不允許跨店查詢',async()=>{
 for(const changed of [{user_id:'other'},{channel_id:'other'},{organization_code:'deepnight'}]){
  const replies=[];await handleEcpayInquiry({customId:'ecpay_inquiry_QN123',user:{id:'u'},channelId:'c',deferred:true,async editReply(p){replies.push(p)}},db({...payment,...changed}),'https://pay.example');
  assert.match(replies[0].content,/不屬於/);
 }
 assert.equal(buildEcpayInquiryRow('QN123').components[0].toJSON().label,'我已付款，重新查詢');
});
test('查單用簽章與時間戳，待確認不得回報已入帳',async()=>{
 const r=await requestEcpayInquiry('QN123',{source:'manual',userId:'u',channelId:'c',baseUrl:'https://pay.example',secret:'test',fetcher:async(url,opts)=>{
  assert.equal(url,'https://pay.example/api/payments/ecpay/service/inquiry');assert.equal(opts.headers['X-Ecpay-Bot-Signature'],createHmac('sha256','test').update(opts.body).digest('hex'));
  const body=JSON.parse(opts.body);assert.equal(body.userId,'u');assert.equal(body.source,'manual');assert.ok(Number.isInteger(body.timestamp));return {ok:true,async json(){return {status:'pending'}}};
 }});assert.equal(r.status,'pending');
});
test('排程每次僅查一筆 ATM/CVS，略過待覆核、冷卻、其他方法並公平輪替',async()=>{
 const now=Date.now();const rows=['NEW','REVIEW','WAIT','OLD','CARD'].map(no=>({merchant_trade_no:no,raw_result:{PaymentType:no==='CARD'?'Credit':'ATM'}}));
 const checks=[{merchant_trade_no:'NEW',last_checked_at:new Date(now-500000).toISOString()},{merchant_trade_no:'OLD',last_checked_at:new Date(now-900000).toISOString()},{merchant_trade_no:'REVIEW',review_required:true},{merchant_trade_no:'WAIT',next_check_at:new Date(now+60000).toISOString()}];
 const called=[];const result=await recoverPendingEcpayPayments(db(rows,checks),'https://pay.example',{now,request:async(no,opts)=>{called.push(no);assert.equal(opts.source,'scheduled');return {status:'pending'}}});assert.deepEqual(called,['OLD']);assert.equal(result.checked,1);
});
