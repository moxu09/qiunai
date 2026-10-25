const test=require('node:test');const assert=require('node:assert/strict');
const {prepareGacha,parseDrawChoice,GUILD}=require('../utils/drawTickets');
const {createIchiban}=require('../utils/ichiban');
const UID='111111111111111111';
function fixture(count=2,poolName='殺比死卡池'){
 const calls=[];const db={from(table){const q={};for(const key of ['select','eq','in','order','limit'])q[key]=(...args)=>{calls.push([table,key,...args]);return q;};
 q.then=(ok,no)=>Promise.resolve(table==='user_items'?{count,error:null}:{data:table==='gacha_pools'?[{id:1,pool_name:poolName,price:50}]:[],error:null}).then(ok,no);return q;},
 rpc:async(name,args)=>{calls.push([name,args]);return {data:name==='qiunai_ichiban_stock'?[]:{draw_id:'00000000-0000-0000-0000-000000000001',ticket_no:1,tickets_used:args.p_use_ticket?1:0,cost:args.p_use_ticket?0:300},error:null};}};
 return{db,calls};
}
test('有券先問，十抽列明使用兩券與剩餘八抽400 ASD；無券不打斷原流程',async()=>{
 const f=fixture();const interaction={guildId:GUILD,user:{id:UID}};
 const {prompt}=await prepareGacha(f.db,interaction,10,1);
 assert.match(prompt.content,/使用 2 張券/);assert.match(prompt.content,/400 ASD/);
 const buttons=prompt.components[0].components;
 assert.equal(parseDrawChoice(buttons[0].custom_id,UID).ticketCount,2);
 assert.equal(parseDrawChoice(buttons[1].custom_id,UID).ticketCount,0);
 assert.throws(()=>parseDrawChoice(buttons[0].custom_id,'222222222222222222'),/不是你的/);
 assert.ok(buttons.every(x=>x.custom_id.length<=100));
 const no=await prepareGacha(fixture(0).db,interaction,1,1);assert.ok(no.choice);assert.equal(no.prompt,undefined);
 const limited=await prepareGacha(fixture(3,'限定卡池').db,interaction,1,1);
 assert.match(limited.prompt.content,/限定卡池券/);
 assert.equal((await prepareGacha(fixture(3,'其他卡池').db,interaction,1,1)).prompt,undefined);
 assert.ok(f.calls.some(x=>x[0]==='user_items'&&x[1]==='eq'&&x[2]==='guild_id'&&x[3]===GUILD));
});
test('不同店別不能使用秋奈抽獎入口',async()=>{
 await assert.rejects(prepareGacha(fixture().db,{guildId:'other',user:{id:UID}},1,1),/僅供秋奈/);
});
function ichibanFixture(count){
 const f=fixture(count);const replies=[];
 const bot=createIchiban({supabase:f.db,enabled:true,client:{channels:{fetch:async()=>({isTextBased:()=>true,send:async()=>({id:'panel'})})}},getPanelMessage:async()=>null,savePanelMessage:async()=>{}});
 const interaction={id:'1234567890123456789',guildId:GUILD,user:{id:UID},isButton:()=>true,customId:'qiunai_ichiban_draw',
 deferReply:async()=>{},deferUpdate:async()=>{},reply:async p=>replies.push(p),editReply:async p=>replies.push(p)};
 return {...f,bot,replies,interaction};
}
test('一番賞有券先問，按使用才呼叫原子兌券，不先扣款',async()=>{
 const f=ichibanFixture(1);await f.bot.handle(f.interaction);
 assert.equal(f.calls.filter(x=>x[0]==='qiunai_ichiban_with_ticket').length,0);
 const buttons=f.replies[0].components[0].toJSON().components;
 f.interaction.customId=buttons[0].custom_id;await f.bot.handle(f.interaction);
 const call=f.calls.find(x=>x[0]==='qiunai_ichiban_with_ticket');assert.equal(call[1].p_use_ticket,true);
 assert.match(f.replies.at(-1).content,/未扣 ASD/);
});
test('一番賞無券直接走原錢包抽獎，不額外詢問用券',async()=>{
 const f=ichibanFixture(0);await f.bot.handle(f.interaction);
 assert.equal(f.calls.find(x=>x[0]==='qiunai_ichiban_with_ticket')[1].p_use_ticket,false);
 assert.match(f.replies.at(-1).content,/已扣 300 ASD/);
});
test('一番賞拒絕他人的確認，不呼叫抽獎',async()=>{
 const f=ichibanFixture(1);f.interaction.customId='qiunai_ichiban_confirm_ticket_222222222222222222_00000000-0000-0000-0000-000000000001';
 await f.bot.handle(f.interaction);assert.match(f.replies[0].content,/不是你的/);
 assert.equal(f.calls.filter(x=>x[0]==='qiunai_ichiban_with_ticket').length,0);
});
