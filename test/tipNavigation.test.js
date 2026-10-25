const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require('discord.js');
const {appendTipBackButton,rewindTipFlow}=require('../utils/tipNavigation');
function flow(){return {flowId:'123_1000',tipperId:'123',createdBy:'123',channelId:'channel',
 gifts:[{name:'煙花',price:99}],staffOptions:[{label:'A',value:'A'}],selectedStaffIds:['A'],quantitySelectionStaffIds:['A','B'],
 staffSelectionCompleted:true,quantityCompleted:true,quantitiesByStaff:{A:[1],B:[0]},allocations:[{amount:99}],totalAmount:99,
 broadcastPreferenceCompleted:true,broadcastEnabled:true,broadcastAnonymous:true,staffSelectionMessageId:'old'};}
test('返回數量保留禮物與原選陪陪（包含全0者），但清除金額和播報設定',()=>{
 const original=flow(),before=JSON.stringify(original),next=rewindTipFlow(original,'quantity',2000);
 assert.equal(JSON.stringify(original),before);assert.equal(next.flowId,'123_2000');
 assert.deepEqual(next.selectedStaffIds,['A','B']);assert.equal(next.gifts[0].price,99);
 for(const key of ['totalAmount','allocations','quantityCompleted','quantitiesByStaff','broadcastEnabled','staffSelectionMessageId'])assert.equal(next[key],undefined);
});
test('返回陪陪解除選人鎖定，返回禮物清除舊禮物和金額',()=>{
 assert.equal(rewindTipFlow(flow(),'staff').staffSelectionCompleted,undefined);
 const next=rewindTipFlow(flow(),'gift');assert.equal(next.gifts,undefined);assert.equal(next.totalAmount,undefined);
});
test('返回播報仍保留數量金額，清除匿名及播報決定',()=>{
 const next=rewindTipFlow(flow(),'broadcast');assert.equal(next.totalAmount,99);assert.equal(next.quantityCompleted,true);
 assert.equal(next.broadcastAnonymous,undefined);assert.equal(next.broadcastPreferenceCompleted,undefined);
});
test('每種付款鎖定均禁止回退，不可修改已存在付款單',()=>{
 for(const fields of [{checkoutStarted:true},{paymentMethod:'匯款'},{keepForPayment:true},{paid:true},{walletPaid:true}])
 assert.throws(()=>rewindTipFlow({...flow(),...fields},'quantity'),/不能返回/);
 assert.throws(()=>rewindTipFlow({...flow(),crownOrder:true},'quantity'),/冠名/);
 assert.throws(()=>rewindTipFlow(flow(),'invalid'),/無效/);
});
test('同毫秒返回也換新ID，避免舊互動仍可操作',()=>assert.equal(rewindTipFlow(flow(),'quantity',1000).flowId,'123_1001'));
test('付款方式已滿5列，返回鍵併入末列、不超過Discord限制',()=>{
 const rows=Array.from({length:5},(_,i)=>new ActionRowBuilder().addComponents(
 new ButtonBuilder().setCustomId(`pay${i}a`).setLabel('付款').setStyle(ButtonStyle.Primary),
 new ButtonBuilder().setCustomId(`pay${i}b`).setLabel('付款').setStyle(ButtonStyle.Primary)));
 const result=appendTipBackButton(rows,'123_1000','broadcast');
 assert.equal(result.length,5);assert.equal(result.at(-1).components.length,3);
 assert.equal(result.at(-1).toJSON().components.at(-1).custom_id,'tip_back_broadcast_123_1000');
});
function fixture({authorized=true,locked=false,exists=true}={}){
 const old=flow();if(locked)old.checkoutStarted=true;
 const pendingTips=new Map(exists?[[old.flowId,old]]:[]),sent=[];
 const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
 const fn=source.slice(source.indexOf('async function handleTipBack('),source.indexOf('async function openTipQuantityModal('));
 const context={pendingTips,rewindTipFlow,canAdvanceTipFlow:()=>authorized,
 setPendingTip(id,data){pendingTips.set(id,data);},
 sendTipQuantityModePrompt:async(channel,id,data)=>sent.push({id,data}),
 sendTipGiftSelect:async()=>{},sendTipBroadcastPreferencePrompt:async()=>{},buildTipStaffPage:()=>({components:[]}),sendTipStaffSelectionStatus:async()=>{}};
 vm.createContext(context);vm.runInContext(fn,context);
 const interaction={customId:'tip_back_quantity_123_1000',channel:{id:'channel'},deferReply:async()=>{},
 message:{edit:async()=>{}},async editReply(p){this.content=p.content;}};
 return {pendingTips,sent,interaction,run:()=>context.handleTipBack(interaction)};
}
test('實際返回處理換新流程且舊付款按鈕與表單找不到原資料',async()=>{
 const f=fixture();await f.run();assert.equal(f.pendingTips.has('123_1000'),false);
 assert.equal(f.pendingTips.size,1);assert.equal(f.sent.length,1);assert.match(f.interaction.content,/已返回上一步/);
});
for(const options of [{authorized:false},{locked:true},{exists:false}])test(`失效／他人／付款中操作不能回退：${JSON.stringify(options)}`,async()=>{
 const f=fixture(options);await f.run();assert.equal(f.sent.length,0);assert(!f.interaction.content.includes('已返回上一步'));
});
test('實際付款處理在銀行查詢及建立付款單前鎖住回退',()=>{
 const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
 const fn=source.slice(source.indexOf('async function handleTipPaymentSelect('),source.indexOf('async function handleTipPaymentSelect(')+6000);
 assert(fn.indexOf('tipData.checkoutStarted = true')<fn.indexOf('await assertBankTransferCanBeSelected'));
 assert.match(source,/customId\.startsWith\("tip_back_"\)/);
});
