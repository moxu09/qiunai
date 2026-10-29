const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {SlashCommandBuilder, EmbedBuilder} = require('discord.js');
const dispatch = fs.readFileSync(path.join(__dirname, '../events/dispatchSystem.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
function functionSource(name) {
  const marker = new RegExp(`(?:async )?function ${name}\\(`).exec(dispatch);
  assert.ok(marker, name);
  const tail = dispatch.slice(marker.index);
  const end = tail.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function load(name, globals = {}) {
  const context = {console, EmbedBuilder, ...globals};
  vm.runInNewContext(functionSource('getCouponDiscount') + '\n' + functionSource('getCouponMaxDiscountPrice') +
    (name.startsWith('getCoupon') ? '' : '\n' + functionSource(name)) + `\nthis.run=${name};`, context);
  return context.run;
}
test('85折為原價85%，上限1500，並維持原有券種的金額上限', () => {
  const discount = load('getCouponDiscount'), maximum = load('getCouponMaxDiscountPrice');
  assert.equal(discount('85折折價券').rate, .85);
  assert.equal(maximum('85折折價券'), 1500);
  for (const [name, rate, cap] of [['95折券',.95,500], ['9折券',.9,800], ['8折折價券',.8,3000], ['7折折價券',.7,5000], ['6折折價券',.6,5000]]) {
    assert.equal(discount(name).rate, rate);assert.equal(maximum(name), cap);
  }
});
function fixture(price, {originalPrice=price, customer='customer'} = {}) {
  const order = {id:'order',customer_id:customer,price,original_price:originalPrice,quote_status:'price_confirmed'};
  const coupon = {id:85,item_name:'85折折價券',item_type:'coupon',user_id:'customer'};
  const calls=[],replies=[];
  const db = {from(table) {
    let patch,removed=false;
    const result = () => ({data:table==='play_orders'?{...order,...patch}:coupon,error:null});
    const query = {select(){return this},eq(){return this},update(value){patch=value;calls.push(['update',value]);return this},
      delete(){removed=true;calls.push(['delete',table]);return this},insert(value){calls.push(['insert',table,value]);return this},
      single:async()=>result(),maybeSingle:async()=>result(),then(resolve,reject){return Promise.resolve(result()).then(resolve,reject)}};
    return query;
  }};
  const pending={customerId:customer,price:originalPrice};
  const interaction={deferred:true,user:{id:'customer'},values:['85'],customId:'quote_select_coupon_order',
    editReply:async value=>{replies.push(value);return value},channel:{send:async()=>{}}};
  return {db,order,pending,interaction,calls,replies};
}
test('報價訂單1500元可用，1501元與原價超額的已折價訂單不扣券不改單', async () => {
  for (const [price, originalPrice, accepted] of [[1500,1500,true],[1501,1501,false],[1200,1600,false],[100,100,true]]) {
    const f=fixture(price,{originalPrice});let nextAmount;
    await load('handleQuoteSelectCoupon',{supabase:f.db,sendPaymentMethodSelect:async(_channel,order)=>{nextAmount=order.final_price}})(f.interaction);
    assert.equal(f.calls.some(x=>x[0]==='delete'),accepted);
    assert.equal(f.calls.some(x=>x[0]==='update'),accepted);
    if(accepted)assert.equal(nextAmount,Math.floor(originalPrice*.85));else assert.match(f.replies[0].content,/1500/);
  }
});
test('新版下單1500元折後1275元，超額不改流程、不扣券', async () => {
  for(const price of [1500,1501]) {
    const f=fixture(price);f.interaction.customId='service_select_coupon_flow';let advanced=false;
    const pendingServiceOrders={get:async()=>f.pending,set:async()=>{advanced=true}};
    await load('handleServiceSelectCoupon',{supabase:f.db,pendingServiceOrders,resetSelectMenuMessage:async()=>{},
      getServiceOriginalPrice:p=>p.price,sendServicePaymentMethodSelect:async()=>{}})(f.interaction);
    assert.equal(advanced,price===1500);assert.equal(f.calls.some(x=>x[0]==='delete'),price===1500);
    if(price===1500){assert.equal(f.pending.finalPrice,1275);assert.equal(f.pending.discountAmount,225);}else assert.match(f.replies[0].content,/1500/);
  }
});
test('非下單人不能把85折券套用到其他人的訂單', async () => {
  const f=fixture(1500,{customer:'other'});
  await load('handleQuoteSelectCoupon',{supabase:f.db})(f.interaction);
  assert.equal(f.calls.length,0);assert.match(f.replies[0].content,/只有下單/);
});
test('舊版下單也檢查原價1500元上限與85折金額', async () => {
  const start=index.indexOf('        let discountAmount = 0;',index.indexOf('if (customId.startsWith("coupon_select_"))'));
  const end=index.indexOf('        const { error: updateError }',start);assert.ok(start>0&&end>start);
  const calculate=vm.runInNewContext(`(async function(order,coupon,interaction){${index.slice(start,end)};return {discountAmount,finalPrice};})`);
  for(const [price, originalPrice, accepted] of [[1500,1500,true],[1501,1501,false],[1200,1600,false]]) {
    const result=await calculate({price,original_price:originalPrice},{item_name:'85折折價券'},{editReply:async value=>value});
    if(accepted){assert.equal(result.finalPrice,1275);assert.equal(result.discountAmount,225);}else assert.match(result.content,/1,500/);
  }
});
test('正式與備用指令定義都提供85折券，並標示1500元上限', () => {
  const start=index.indexOf('new SlashCommandBuilder()\n    .setName("發送優惠券")');
  const end=index.indexOf('\n  new SlashCommandBuilder()',start+1);assert.ok(start>=0&&end>start);
  const runtime=vm.runInNewContext(index.slice(start,end).replace(/,\s*$/,''),{SlashCommandBuilder}).toJSON();
  const backup=require('../commands').find(c=>c.name==='發送優惠券');
  for(const command of [runtime,backup]){
    const choice=command.options.find(o=>o.name==='優惠券').choices.find(c=>c.value==='85折折價券');
    assert.match(choice.name,/1500/);
  }
});
