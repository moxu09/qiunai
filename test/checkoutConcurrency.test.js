const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

test('付款開始後舊表單與編輯按鈕全部鎖住，但付款確認及取消仍檢查原權限',()=>{
  const fn=source.slice(source.indexOf('function canAdvanceTipFlow('),
    source.indexOf('function getTipGiftListText('));
  const ctx={canOperateTipFlow:({actorId,creatorId,isCustomerService})=>actorId===creatorId||isCustomerService,
    isAdminOrStaff:()=>false};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  const tip={tipperId:'buyer',checkoutStarted:true};
  for(const customId of ['tip_quantity_modal_same_x','tip_gift_x','tip_staff_x','tip_broadcast_yes_x',
    'tip_custom_price_modal_x','tip_back_quantity_x']) {
    assert.equal(ctx.canAdvanceTipFlow({user:{id:'buyer'},customId},tip),false);
  }
  for(const customId of ['confirm_tip_wallet_x','cancel_tip_wallet_x','tip_payment_x']) {
    assert.equal(ctx.canAdvanceTipFlow({user:{id:'buyer'},customId},tip),true);
    assert.equal(ctx.canAdvanceTipFlow({user:{id:'other'},customId},tip),false);
  }
});


function cancelFixture(extra = {}, authorized = true) {
  const tip = {flowId:'buyer_1000',tipperId:'buyer',channelId:'channel',
    paymentMethod:'ASD錢包',checkoutStarted:true,keepForPayment:true,...extra};
  const pendingTips = new Map([['buyer_1000',tip]]),sent=[];
  const fn=source.slice(source.indexOf('async function cancelTipPaymentChoice('),
    source.indexOf('async function getPanelMessage('));
  const ctx={structuredClone,pendingTips,canAdvanceTipFlow:()=>authorized,
    setPendingTip:(id,data)=>pendingTips.set(id,data),formatTipStaffMentions:()=>'<@staff>',
    getTipStaffIds:()=>['staff'],sendTipPaymentSelectPrompt:async(channel,id)=>sent.push(id)};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  const interaction={channel:{id:'channel'},message:{edit:async()=>{}},
    async editReply(p){this.content=p.content;}};
  return {pendingTips,sent,interaction,run:()=>ctx.cancelTipPaymentChoice(interaction,'buyer_1000',
    String(tip.paymentMethod).includes('扣薪')?'salary':'wallet')};
}
test('未確認前取消錢包或扣薪會換新ID並重新開付款選單，舊按鈕不能繼續',async()=>{
  for (const paymentMethod of ['ASD錢包','員工扣薪']) {
    const f=cancelFixture({paymentMethod});await f.run();
    assert.equal(f.pendingTips.has('buyer_1000'),false);assert.equal(f.sent.length,1);
    const next=f.pendingTips.get(f.sent[0]);
    assert.equal(next.checkoutStarted,false);assert.equal(next.paymentMethod,undefined);
  }
});
test('他人取消、過期方式、付款確認已送出或已付款時不可建立新流程',async()=>{
  for (const [extra,authorized] of [[{},false],[{paymentMethod:'街口支付'},true],
    [{paymentAttempted:true},true],[{paid:true},true],[{walletPaid:true},true]]) {
    const f=cancelFixture(extra,authorized);await f.run();
    assert.equal(f.sent.length,0);assert.equal(f.pendingTips.has('buyer_1000'),true);
  }
});


test('活動抽成查詢失敗會中止，不可當成沒有活動而少算薪資', async () => {
  const fn = source.slice(source.indexOf('async function getActiveQiunaiCommissionActivity('),
    source.indexOf('async function getQiunaiCommissionInfo('));
  const q = { select(){return q},eq(){return q},not(){return q},lte(){return q},gt(){return q},
    maybeSingle: async()=>({data:null,error:Error('database unavailable')}) };
  const ctx = {supabase:{from:()=>q},console:{error(){}}};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  await assert.rejects(ctx.getActiveQiunaiCommissionActivity('2026-10-22T00:00:00Z'), /已停止薪資計算/);
});

test('兩次同時點付款只執行一次銀行前置檢查，第二次不可建立另一付款單', async () => {
  const fn = source.slice(source.indexOf('async function handleTipPaymentSelect('),
    source.indexOf('async function getPanelMessage('));
  let release, entered;
  const waiting = new Promise(resolve=>{entered=resolve});
  const pending = new Promise(resolve=>{release=resolve});
  let preflightCount=0;
  const tip = {tipperId:'buyer',item:'煙花',amount:99,selectedStaffIds:['staff']};
  const ctx = { pendingTips:new Map([['tip',tip]]),
    getPaymentMethodSelection:()=>({entityId:'tip',paymentMethod:'匯款'}),
    canAdvanceTipFlow:()=>true,getTipStaffIds:()=>['staff'],hasSelfTip:()=>false,
    formatTipStaffMentions:()=>'<@staff>',refreshTipTotals:()=>[{amount:99}],
    setPendingTip(){},isBankTransfer:()=>true,supabase:{},
    assertBankTransferCanBeSelected:async()=>{preflightCount++;entered();await pending;throw Error('暫停測試');},
  };
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  const interaction=()=>({deferred:false,replied:false,deferReply:async()=>{},
    async editReply(p){this.content=p.content;}});
  const first=interaction(),second=interaction();
  const task=ctx.handleTipPaymentSelect(first);
  await waiting;
  try {
    await ctx.handleTipPaymentSelect(second);
    assert.match(second.content,/已進入付款流程/);
    assert.equal(preflightCount,1);
  } finally {release();await task;}
  assert.equal(tip.checkoutStarted,false,'無付款副作用的前置檢查失敗應解鎖');
});
