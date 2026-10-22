const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseTipQuantityList, validateTipQuantityMatrix, buildTipAllocations,
  getTipAllocationTotal, getTipStaffIds, getTipGiftSelections} = require('../utils/tips');
const gifts = [{key:'firework',name:'煙花',price:99},{key:'cookie',name:'小熊棉花糖餅乾',price:33}];
const flow = () => ({gifts,selectedStaffIds:['A','B']});
test('0～999可輸入，負數、小數、超界及數量不符仍拒絕',()=>{
  assert.deepEqual(parseTipQuantityList('1,0',2),[1,0]);
  assert.deepEqual(parseTipQuantityList('0，999',2),[0,999]);
  for(const text of ['-1,0','1.5,0','1000,0','x,0','1'])assert.throws(()=>parseTipQuantityList(text,2));
});
test('同時送不同人不同禮物，0不會變成1，總額132',()=>{
  const f={...flow(),quantitiesByStaff:{A:[1,0],B:[0,1]}};
  assert.deepEqual(buildTipAllocations(f).map(x=>[x.staffId,x.item,x.amount]),[
    ['A','煙花×1',99],['B','小熊棉花糖餅乾×1',33],
  ]);
  assert.equal(getTipAllocationTotal(f),132);
});
test('共享數量的0及整位陪陪的0均不產生項目或薪資分配',()=>{
  assert.equal(getTipAllocationTotal({...flow(),sharedQuantities:[0,2]}),132);
  assert.deepEqual(buildTipAllocations({...flow(),quantitiesByStaff:{A:[0,0],B:[0,2]}}).map(x=>x.staffId),['B']);
});
test('整筆全0拒絕，單位全0但其他陪陪有禮物則允許',()=>{
  assert.throws(()=>validateTipQuantityMatrix({A:[0,0],B:[0,0]}),/不能全部填 0/);
  assert.doesNotThrow(()=>validateTipQuantityMatrix({A:[0,0],B:[0,1]}));
});
test('自訂禮物尚待填價不能因金額0遺失正數數量',()=>{
  const allocations=buildTipAllocations({selectedStaffIds:['A'],gifts:[{name:'客製',price:0,customPrice:true}],sharedQuantities:[2]});
  assert.equal(allocations.length,1);assert.equal(allocations[0].lines[0].quantity,2);
});
test('舊付款資料的0不復活，也不能回退到殘留金額',()=>{
  assert.deepEqual(buildTipAllocations({allocations:[{staffId:'A',amount:99,lines:[{name:'煙花',price:99,quantity:0,subtotal:99}]}]}),[]);
  assert.equal(buildTipAllocations({allocations:[{staffId:'A',item:'舊打賞',amount:99} ]})[0].amount,99);
});

function modalFixture(raw) {
  const tip=flow();let advanced=false;
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const fn=source.slice(source.indexOf('async function handleTipQuantityModal('),source.indexOf('async function handleCrownSuffixChoice('));
  const ctx={pendingTips:new Map([['tip',tip]]),canAdvanceTipFlow:()=>true,
    getTipGiftSelections,getTipStaffIds,parseTipQuantityList,validateTipQuantityMatrix,
    refreshTipTotals(t){const allocations=buildTipAllocations(t);t.allocations=allocations;t.totalAmount=getTipAllocationTotal(t);return allocations;},
    setPendingTip(){},sendTipBroadcastPreferencePrompt:async()=>{advanced=true;},
    getTipAllocationText:()=>'',requestCustomTipPrice:async()=>{},};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  const interaction={customId:'tip_quantity_modal_separate_tip',fields:{getTextInputValue:()=>raw},
    deferReply:async()=>{},async editReply(p){this.content=p.content;},message:{edit:async()=>{}}};
  return {tip,interaction,run:()=>ctx.handleTipQuantityModal(interaction),advanced:()=>advanced};
}
test('實際表單拒絕全0，並且不污染原本待處理資料',async()=>{
  const f=modalFixture('0,0\n0,0');await f.run();
  assert.match(f.interaction.content,/不能全部填 0/);
  assert.equal(f.tip.quantitiesByStaff,undefined);assert.equal(f.tip.quantityCompleted,undefined);assert.equal(f.advanced(),false);
});
test('實際表單可輸入互斥禮物，結帳明細與總額一致',async()=>{
  const f=modalFixture('1,0\n0,1');await f.run();
  assert.equal(f.tip.totalAmount,132);assert.equal(f.advanced(),true);
  assert.equal(f.tip.allocations[0].lines.length,1);assert.equal(f.tip.allocations[1].lines.length,1);
});
test('實際表單排除全0陪陪的付款與播報對象',async()=>{
  const f=modalFixture('0,0\n0,1');await f.run();
  assert.equal(JSON.stringify(f.tip.selectedStaffIds),'["B"]');assert.equal(f.tip.totalAmount,33);
});
