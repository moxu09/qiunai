const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {Collection,EmbedBuilder}=require('discord.js');
const source=fs.readFileSync(require.resolve('../events/dispatchSystem'),'utf8');
const fn=source.slice(source.indexOf('async function createWebsiteOrder('),source.indexOf('async function sendStaffQuotePanel('));
function fixture(memberState='joined',withStaff=true){
 let created=0,inserted=0,quoteCount=0;const sent=[];const channels=new Collection();
 const member={user:{username:'customer'},pending:memberState==='screening'};
 const guild={id:'1206138511535898654',roles:{fetch:async()=>{},cache:new Collection(withStaff?[['staff',{}],['player',{}]]:[['player',{}]])},
 members:{fetch:async()=>{if(memberState==='absent')throw Object.assign(Error('Unknown Member'),{code:10007});return member;}},
 channels:{fetch:async()=>channels,create:async options=>{created++;const c={id:'channel',...options,messages:{fetch:async()=>new Collection(sent.map((m,i)=>[String(i),m]))},send:async p=>{sent.push({author:{id:'bot'},embeds:p.embeds.map(e=>e.toJSON()),components:[]});}};channels.set(c.id,c);return c;}}};
 let order=null;const db={from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:order}),insert(data){inserted++;order={id:'order',...data};return q;},single:async()=>({data:order})};return q;}};
 const context={supabase:db,client:{user:{id:'bot'},guilds:{fetch:async()=>guild}},ChannelType:{GuildText:0},EmbedBuilder,require,
 process:{env:{STAFF_ROLE:'staff'}},parseRoleIds:()=>[],ORDER_TICKET_CATEGORY_ID:'category',QIUNAI_WATER_BLUE:123,
 resolveTicketParentId:async()=> 'category',getNextPlayOrderNumber:async()=> 'ORD-TEST',sendStaffQuotePanel:async()=>{quoteCount++;}};
 vm.runInNewContext(fn+'\nthis.execute=createWebsiteOrder;',context);
 const payload={requestId:'WEB-00000000-0000-4000-8000-000000000001',userId:'1024589023144058902',requirements:{customerName:'客人',game:'特戰英豪',serviceType:'娛樂',quantity:'2小時',platform:'PC',companionCount:1,notes:''}};
 return {context,payload,channels,sent,get created(){return created;},get inserted(){return inserted;},get quoteCount(){return quoteCount;},get order(){return order;}};
}
test('未加入或待規則驗證時不開區、不新增訂單',async()=>{
 for(const state of ['absent','screening']){const f=fixture(state);assert.equal(await f.context.execute(f.payload),null);assert.equal(f.created,0);assert.equal(f.inserted,0);}
});
test('私人開區只允許會員、客服及機器人；帶入需求但不標付款',async()=>{
 const f=fixture();await f.context.execute(f.payload);assert.equal(f.created,1);assert.equal(f.inserted,1);
 const permissions=f.channels.get('channel').permissionOverwrites;
 assert.deepEqual(Array.from(permissions[0].deny),['ViewChannel']);assert.equal(permissions.some(x=>x.id==='player'),false);
 assert.equal(f.order.customer_id,f.payload.userId);assert.equal(f.order.paid,false);assert.equal(f.order.price,0);assert.equal(f.order.status,'waiting_quote');assert.match(f.order.note,/MANUAL_DISPATCH/);assert.match(f.sent[0].embeds[0].description,/2小時/);
});
test('客服權限缺失時不建立無人可處理的私人頻道',async()=>{
 const f=fixture('joined',false);await assert.rejects(f.context.execute(f.payload),/客服身分組/);assert.equal(f.created,0);
});
