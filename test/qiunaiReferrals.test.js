const test=require('node:test'),assert=require('node:assert/strict');
const {createQiunaiReferrals,referralPanel,resultText,GUILD_ID,CHANNEL_ID}=require('../events/qiunaiReferrals');
const code='QN0123456789ABCDEF';
function fixture(result={status:'pending',paid_amount:0}){
 const calls=[],replies=[];let fail=false;
 const db={rpc:async(name,args)=>{calls.push({name,args});return fail?{error:Error('database unavailable')}:{data:name==='qiunai_referral_get_code'?code:result};}};
 const system=createQiunaiReferrals({db,client:{},logger:{error(){}}});
 const interaction=(customId,extra={})=>({customId,guildId:GUILD_ID,channelId:CHANNEL_ID,user:{id:'111111111111111111',bot:false},
  isButton:()=>customId!=='qref_submit',isModalSubmit:()=>customId==='qref_submit',
  fields:{getTextInputValue:()=>code.toLowerCase()},deferReply:async p=>replies.push(p),
  reply:async p=>replies.push(p),editReply:async p=>replies.push(p),showModal:async p=>replies.push(p),...extra});
 return{calls,replies,interaction,system,fail(){fail=true}};
}
test('面板只有生成及輸入兩個按鈕，清楚寫實付、500門檻及一人一次',()=>{
 const p=referralPanel();assert.equal(p.components[0].components.length,2);
 assert.match(p.embeds[0].data.description,/一般訂單與打賞皆算/);
 assert.match(p.embeds[0].data.description,/實付滿 500/);assert.match(p.embeds[0].data.description,/每人只能領取一次/);
});
test('生成自己的固定邀請碼且僅本人可見',async()=>{const f=fixture();await f.system.handle(f.interaction('qref_generate'));
 assert.deepEqual(f.calls[0],{name:'qiunai_referral_get_code',args:{p_user_id:'111111111111111111'}});
 assert.equal(f.replies[0].flags,64);assert(f.replies.at(-1).content.includes(code));});
test('輸入按鈕立即開表單，不先等待資料庫',async()=>{const f=fixture();await f.system.handle(f.interaction('qref_enter'));
 assert.equal(f.calls.length,0);assert.equal(f.replies[0].data.custom_id,'qref_submit');});
test('輸入代碼正規化，身分只能取自 Discord 操作者',async()=>{const f=fixture({status:'rewarded'});await f.system.handle(f.interaction('qref_submit'));
 assert.deepEqual(f.calls[0],{name:'qiunai_referral_bind',args:{p_invitee_id:'111111111111111111',p_code:code}});assert.match(f.replies.at(-1).content,/1 張.*2 張/);});
test('不符合、已領及首單未達標不能顯示新發獎勵',()=>{
 assert.match(resultText({status:'pending',paid_amount:499}),/不能用第二筆/);
 assert.match(resultText({status:'rewarded',already_granted:true}),/沒有重複/);
 assert.match(resultText({status:'ineligible',reason:'首單未滿500'}),/首單未滿500/);
 assert.throws(()=>resultText({status:'invalid'}),/結果不正確/);
});
test('其他店、私訊、錯頻道與機器人不可以操作',async()=>{for(const extra of [{guildId:'other'},{guildId:null},{channelId:'other'},{user:{id:'111111111111111111',bot:true}}]){
 const f=fixture();await f.system.handle(f.interaction('qref_generate',extra));assert.equal(f.calls.length,0);assert.equal(f.replies[0].flags,64);
}});
test('資料庫錯誤不回報成功，也不在本機直接發券',async()=>{const f=fixture();f.fail();await f.system.handle(f.interaction('qref_submit'));assert.match(f.replies.at(-1).content,/❌.*database unavailable/);});
test('付款核對呼叫資料庫原子程序；不相關互動不處理',async()=>{const f=fixture();await f.system.reconcile();assert.equal(f.calls[0].name,'qiunai_referral_process_pending');assert.equal(await f.system.handle({customId:'qcs_open'}),false);});
