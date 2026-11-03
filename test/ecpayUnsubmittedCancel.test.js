const test=require('node:test'),assert=require('node:assert/strict');
const {buildEcpayPaymentRows,handleEcpayUnsubmittedCancel}=require('../utils/ecpayDiscord');
test('只有訂單刷卡選項提供取消未送出付款；超商與一般呼叫不新增按鈕',()=>{
 const p={platformOrderId:'QNT1',paymentUrl:'https://pay.example/payments/ecpay/service/checkout?order=QNT1'};
 assert.equal(buildEcpayPaymentRows(p,350,{onlyMethod:'CARD',allowCancel:true}).length,2);
 assert.equal(buildEcpayPaymentRows(p,350,{onlyMethod:'CARD'}).length,1);
 assert.equal(buildEcpayPaymentRows(p,350,{onlyMethod:'CVS',allowCancel:true}).length,1);
});
test('取消將付款編號、本人與原頻道交給原子RPC，不在JS端直接加點數或發券',async()=>{
 const calls=[],replies=[];const i={customId:'ecpay_cancel_unsubmitted_QNT1',user:{id:'u'},guildId:'1206138511535898654',channelId:'c',deferred:true,message:{edit:async()=>{}},editReply:async p=>replies.push(p)};
 assert.equal(await handleEcpayUnsubmittedCancel(i,{rpc:async(n,p)=>{calls.push([n,p]);return{data:{points_released:50}};}}),true);
 assert.deepEqual(calls,[['qiunai_cancel_unsubmitted_card',{p_trade_no:'QNT1',p_user_id:'u',p_channel_id:'c'}]]);assert.match(replies[0].content,/已取消/);
});
test('銀行授權已送出不會提示已返還；跨店不呼叫RPC',async()=>{
 const replies=[];const i={customId:'ecpay_cancel_unsubmitted_QNT1',user:{id:'u'},guildId:'1206138511535898654',channelId:'c',deferred:true,editReply:async p=>replies.push(p)};
 await handleEcpayUnsubmittedCancel(i,{rpc:async()=>({error:{message:'銀行授權已送出'}})});assert.match(replies[0].content,/❌ 銀行授權已送出/);
 await handleEcpayUnsubmittedCancel({...i,guildId:'other'},{rpc:async()=>{throw Error('不可跨店');}});assert.match(replies[1].content,/僅供秋奈/);
});
