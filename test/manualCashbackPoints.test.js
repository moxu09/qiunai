const test = require('node:test');
const assert = require('node:assert/strict');
const {handleManualCashbackPoints} = require('../utils/manualCashbackPoints');
function fixture(patch={}) {
  const replies=[]; let calls=0, sent=0;
  const interaction={id:'1561500000000000001',guildId:'1206138511535898654',channelId:'1561500000000000002',
    user:{id:'847840193859682304'},guild:{members:{fetch:async()=>({})}},
    options:{getUser:()=>({id:'1024589023144058902',bot:false}),getNumber:()=>12.34,getString:()=> '漏發補登'},
    editReply:async p=>{replies.push(p);return p;},...patch};
  const deps={isAuthorized:()=>true,db:{rpc:async(name,args)=>{calls++;assert.equal(name,'qiunai_grant_manual_points');assert.equal(args.p_points,12.34);return {data:{requested_points:12.34,credited_points:10,debt_repaid:2.34,balance_after:110,already_applied:false}};}},notify:async()=>{sent++;}};
  return {interaction,deps,replies,get calls(){return calls;},get sent(){return sent;}};
}
test('僅限秋奈客服或管理員；異店、私訊與一般會員不觸及帳務',async()=>{
  for(const patch of [{guildId:'other'},{guildId:null},{}]) {
    const f=fixture(patch);if(!Object.keys(patch).length)f.deps.isAuthorized=()=>false;
    await handleManualCashbackPoints(f.interaction,f.deps);assert.equal(f.calls,0);assert.equal(f.sent,0);
  }
});
test('支援兩位小數，顯示欠點沖抵、真實入帳與餘額',async()=>{
  const f=fixture();await handleManualCashbackPoints(f.interaction,f.deps);
  assert.equal(f.calls,1);assert.equal(f.sent,1);assert.match(f.replies[0].content,/實際入帳：10 點/);
});
test('拒絕零、負數、非有限、超額與超過兩位小數',async()=>{
  for(const points of [0,-1,NaN,Infinity,1000001,0.001,1.234]) {
    const f=fixture();f.interaction.options.getNumber=()=>points;
    await handleManualCashbackPoints(f.interaction,f.deps);assert.equal(f.calls,0);
  }
});
test('機器人與不在伺服器的對象不能收點',async()=>{
  for(const bot of [true,false]){const f=fixture();if(bot)f.interaction.options.getUser=()=>({id:'bot',bot:true});
    else f.interaction.guild.members.fetch=async()=>{throw Error('unknown member');};
    await handleManualCashbackPoints(f.interaction,f.deps);assert.equal(f.calls,0);}
});
test('資料庫失敗不發成功訊息；私訊失敗不重發點數',async()=>{
  const f=fixture();f.deps.db.rpc=async()=>({error:Error('offline')});
  await assert.rejects(handleManualCashbackPoints(f.interaction,f.deps),/offline/);assert.equal(f.sent,0);
  const g=fixture();g.deps.notify=async()=>{throw Error('blocked');};
  await handleManualCashbackPoints(g.interaction,g.deps);assert.equal(g.calls,1);assert.match(g.replies[0].content,/已入帳，但私訊無法送達/);
});
test('同一發放請求重試不重寄私訊，沿用資料庫防重複結果',async()=>{
  const f=fixture();f.deps.db.rpc=async()=>({data:{requested_points:12.34,credited_points:12.34,debt_repaid:0,balance_after:12.34,already_applied:true}});
  await handleManualCashbackPoints(f.interaction,f.deps);assert.equal(f.sent,0);assert.match(f.replies[0].content,/未重複發放/);
});
