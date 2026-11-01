const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {buildTipAllocations} = require('../utils/tips');
const {selectTipBroadcastChannel:route,getTipBroadcastChannels,splitTipBroadcastAllocations,buildTipBroadcastContent,TIP_BROADCAST_CHANNEL_ID:normal,LARGE_TIP_BROADCAST_CHANNEL_ID:large} = require('../utils/tipBroadcasts');

test('每位陪陪滿1300才轉超頻的愛，不合併其他陪陪或跨單累積',()=>{
 assert.equal(large,'1544713687900880936');
 for(const [n,c] of [[1299,normal],[1300,large],[1301,large]])assert.equal(route(n),c);
 const channels=getTipBroadcastChannels([{staffId:'a',amount:800},{staffId:'b',amount:500}]);
 assert.equal(channels.get('a'),normal);assert.equal(channels.get('b'),normal);
 assert.equal(getTipBroadcastChannels([{staffId:'a',amount:800}]).get('a'),normal);
 assert.equal(getTipBroadcastChannels([{staffId:'a',amount:500}]).get('a'),normal);
 assert.throws(()=>route(NaN),/金額無效/);
});
test('同一陪陪不同品項含客製打賞合計，其他陪陪不跟著升頻',()=>{
 const flow={selectedStaffIds:['a','b','c'],gifts:[{key:'gift',name:'A',price:100},{key:'custom',name:'客製打賞',price:650,customPrice:true}],quantitiesByStaff:{a:[0,2],b:[6,1],c:[0,0]}};
 const allocations=buildTipAllocations(flow),channels=getTipBroadcastChannels(allocations);
 assert.equal(channels.get('a'),large);assert.equal(channels.get('b'),normal);assert.equal(channels.has('c'),false);
 const jobs=splitTipBroadcastAllocations(allocations);
 assert.ok(jobs.filter(j=>j.staffId==='a').every(j=>j.channelId===large));
 assert.ok(jobs.filter(j=>j.staffId==='b').every(j=>j.channelId===normal));
});
test('回呼持久明細及同人多筆明細依相同門檻分流',()=>{
 const paid={allocations:[{staffId:'a',lines:[{name:'A',price:600,quantity:1,subtotal:600}]},{staffId:'a',lines:[{name:'B',price:350,quantity:2,subtotal:700}]},{staffId:'b',lines:[{name:'C',price:100,quantity:1,subtotal:100}]}]};
 const jobs=splitTipBroadcastAllocations(buildTipAllocations(paid));
 assert.deepEqual(jobs.map(j=>j.channelId),[large,large,normal]);
});
const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
const body=source.slice(source.indexOf('async function sendTipBroadcastSafely'),source.indexOf('function getTipStaffSelectionContent'));
function makeSender({failedChannel,anonymous=false}={}){
 const sent=[],fetched=[],receipts=[],errors=[];
 const ctx={buildTipAllocations,splitTipBroadcastAllocations,buildTipBroadcastContent,
 sendTipReceiptSafely:async(...a)=>receipts.push(a),getTipBroadcastEntry:()=>({gift:{name:'禮物'},broadcast:{imageFile:'test.png',description:'介紹'}}),
 client:{channels:{fetch:async id=>{fetched.push(id);if(id===failedChannel)throw new Error('missing');return{id,isTextBased:()=>true};}}},
 sendTipBroadcastMessage:async(channel,payload,tip,key)=>sent.push({channel:channel.id,payload,key}),
 path,__dirname:'/test',console:{error:(...a)=>errors.push(a)}};
 vm.createContext(ctx);vm.runInContext(body+';this.send=sendTipBroadcastSafely;',ctx);
 const tip={tipperId:'boss',flowId:'test-flow',broadcastEnabled:true,broadcastAnonymous:anonymous,allocations:[{staffId:'a',lines:[{key:'x',name:'大禮',price:650,quantity:2}]},{staffId:'b',lines:[{key:'y',name:'小禮',price:100,quantity:1}]}]};
 return{send:ctx.send,tip,sent,fetched,receipts,errors};
}
test('實際播報分往兩個頻道，圖片、文案與感謝文都跟隨該位陪陪',async()=>{
 const h=makeSender();await h.send(h.tip);
 const gifts=h.sent.filter(x=>!x.key.startsWith('thanks:'));
 assert.equal(gifts.length,2);assert.equal(gifts[0].channel,large);assert.match(gifts[0].payload.content,/<@a>/);assert.doesNotMatch(gifts[0].payload.content,/<@b>/);
 assert.equal(gifts[1].channel,normal);assert.match(gifts[1].payload.content,/<@b>/);assert.doesNotMatch(gifts[1].payload.content,/<@a>/);
 assert.ok(gifts.every(x=>x.payload.files.length===1));
 assert.equal(h.sent.filter(x=>x.key.startsWith('thanks:')).length,2);
 assert.equal(new Set(h.sent.map(x=>x.key)).size,4);assert.equal(h.receipts.length,1);
});
test('單一頻道失敗不阻止其他陪陪在原頻道播報',async()=>{
 const h=makeSender({failedChannel:large});await h.send(h.tip);
 assert.equal(h.sent.length,2);assert.ok(h.sent.every(x=>x.channel===normal));assert.ok(h.errors.length>0);
});
test('匿名、拒絕播報與冠名排除維持原選擇，收據仍是一筆',async()=>{
 const h=makeSender({anonymous:true});await h.send(h.tip);
 for(const x of h.sent.filter(x=>!x.key.startsWith('thanks:'))){assert.match(x.payload.content,/匿名闆闆/);assert.doesNotMatch(x.payload.content,/<@boss>/);assert.deepEqual(Array.from(x.payload.allowedMentions.users),[x.channel===large?'a':'b']);}
 for(const p of [{broadcastEnabled:false},{crownOrder:true}]){const quiet=makeSender();await quiet.send({...quiet.tip,...p});assert.equal(quiet.sent.length,0);assert.equal(quiet.receipts.length,1);}
});
test('付款前提示說明逐人判斷，混合訂單會列出兩個目的頻道',()=>{
 const prompt=source.slice(source.indexOf('async function sendTipBroadcastPreferencePrompt'),source.indexOf('async function handleTipBroadcastChoice'));
 assert.match(prompt,/getTipBroadcastChannels\(buildTipAllocations\(tipData\)\)/);
 assert.match(prompt,/單一陪陪滿 1,300 元/);assert.match(prompt,/不合併不同陪陪的金額/);
 assert.doesNotMatch(prompt,/所有品項及受賞人合計/);
});
test('多人客製打賞合計1300但各人未滿，仍可選擇原頻道播報',async()=>{
 const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require('discord.js');
 const prompt=source.slice(source.indexOf('async function sendTipBroadcastPreferencePrompt'),source.indexOf('async function handleTipBroadcastChoice'));
 const messages=[],ctx={getTipBroadcastChannels,buildTipAllocations,ActionRowBuilder,ButtonBuilder,ButtonStyle,setPendingTip:()=>{},appendTipBackButton:rows=>rows};
 vm.createContext(ctx);vm.runInContext(prompt+';this.prompt=sendTipBroadcastPreferencePrompt;',ctx);
 const tip={tipperId:'boss',allocations:[{staffId:'a',lines:[{key:'custom',name:'客製打賞',price:800,quantity:1}]},{staffId:'b',lines:[{key:'custom',name:'客製打賞',price:500,quantity:1}]}]};
 await ctx.prompt({send:async m=>messages.push(m)},'flow',tip);
 assert.equal(messages.length,1);assert.match(messages[0].content,new RegExp(`<#${normal}>`));assert.doesNotMatch(messages[0].content,new RegExp(`<#${large}>`));assert.equal(tip.broadcastPreferenceShown,true);
});
