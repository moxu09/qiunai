const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {buildTipAllocations}=require('../utils/tips');
const {selectTipBroadcastChannel:route,TIP_BROADCAST_CHANNEL_ID:normal,LARGE_TIP_BROADCAST_CHANNEL_ID:large}=require('../utils/tipBroadcasts');
test('打賞合計達1300含邊界才轉超頻的愛，不跨單累積',()=>{
 assert.equal(large,'1544713687900880936');
 assert.equal(route([{amount:1299}]),normal);assert.equal(route([{amount:1300}]),large);assert.equal(route([{amount:1301}]),large);
 assert.equal(route([{amount:800},{amount:500}]),large);assert.equal(route([{amount:800}]),normal);assert.equal(route([{amount:500}]),normal);
 assert.equal(route([]),normal);assert.throws(()=>route([{amount:NaN}]),/金額無效/);
});
test('不同禮物、數量、客製打賞及多人金額一起算，0份不列入',()=>{
 const flow={selectedStaffIds:['p1','p2'],gifts:[{key:'a',name:'A',price:100},{key:'b',name:'B',price:200},{key:'custom',name:'客製打賞',price:350,customPrice:true}],quantitiesByStaff:{p1:[3,0,1],p2:[0,5,0]}};
 const allocations=buildTipAllocations(flow);assert.equal(allocations.reduce((n,a)=>n+a.amount,0),1650);assert.equal(route(allocations),large);
 flow.quantitiesByStaff.p2=[0,0,0];assert.equal(route(buildTipAllocations(flow)),normal);
});
test('金流回呼的持久明細與即時付款使用同一合計規則',()=>{
 const paid={allocations:[{staffId:'p1',lines:[{name:'A',price:600,quantity:1,subtotal:600}]},{staffId:'p2',lines:[{name:'B',price:350,quantity:2,subtotal:700}]}]};
 assert.equal(route(buildTipAllocations(paid)),large);
});
test('共用播報入口保留隱私選擇及冠名排除，圖片與感謝文使用同一頻道',()=>{
 const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
 const body=source.slice(source.indexOf('async function sendTipBroadcastSafely'),source.indexOf('function getTipStaffSelectionContent'));
 assert.match(body,/!tipData\?\.broadcastEnabled \|\| tipData.crownOrder/);
 assert.match(body,/selectTipBroadcastChannel\(allocations\)/);assert.match(body,/fetch\(broadcastChannelId\)/);
 assert.match(body,/sendTipBroadcastMessage\(channel, thanksPayload/);
});
