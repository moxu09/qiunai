const test=require('node:test');
const assert=require('node:assert/strict');
const {GUILD,KILL_TICKETS,ICHIBAN_TICKETS,ticketBalanceButton,handleTicketBalance}=require('../utils/drawTickets');
const {createIchiban}=require('../utils/ichiban');
function fixture(kind,count=3,error=null){
 const calls=[],replies=[];
 const db={from(table){assert.equal(table,'user_items');const q={};
  for(const method of ['select','eq','in'])q[method]=(...args)=>{calls.push([method,...args]);return q;};
  q.then=(ok,no)=>Promise.resolve({count,error}).then(ok,no);return q;}};
 const interaction={customId:ticketBalanceButton(kind).toJSON().custom_id,guildId:GUILD,user:{id:'123456789012345678'},
  deferReply:async p=>replies.push(p),reply:async p=>replies.push(p),editReply:async p=>replies.push(p)};
 return {db,interaction,calls,replies};
}
for(const kind of ['kill','ichiban'])test(`${kind} 查本人券數，私人回覆且僅讀取對應店別與券種類`,async()=>{
 const f=fixture(kind);assert.equal(await handleTicketBalance(f.db,f.interaction),true);
 assert.equal(f.replies[0].flags,64);assert.match(f.replies[1].content,/3 張/);
 assert.deepEqual(f.calls.find(x=>x[1]==='user_id'),['eq','user_id',f.interaction.user.id]);
 assert.deepEqual(f.calls.find(x=>x[1]==='guild_id'),['eq','guild_id',GUILD]);
 assert.ok(f.calls.some(x=>x[0]==='in'&&JSON.stringify(x[2])===JSON.stringify(kind==='kill'?KILL_TICKETS:ICHIBAN_TICKETS)));
});
test('零券正常顯示，讀取失敗不冒充零券，其他店別不讀資料',async()=>{
 const zero=fixture('kill',0);await handleTicketBalance(zero.db,zero.interaction);assert.match(zero.replies[1].content,/0 張/);
 const failed=fixture('kill',0,Error('offline'));await handleTicketBalance(failed.db,failed.interaction);assert.match(failed.replies[1].content,/暫時無法/);
 const other=fixture('kill');other.interaction.guildId='other';await handleTicketBalance(other.db,other.interaction);
 assert.equal(other.calls.length,0);assert.equal(other.replies[0].flags,64);
});
test('有限定券而沒有殺必死券時列出券種差異，不把全背包說成零券',async()=>{
 const f=fixture('kill');
 f.db.from=()=>{let count=0;const q={select(){return q;},eq(){return q;},in(_,names){count=names.includes('限定卡池抽獎券')?2:0;return q;},then(ok,no){return Promise.resolve({count,error:null}).then(ok,no);}};return q;};
 await handleTicketBalance(f.db,f.interaction);
 assert.match(f.replies[1].content,/0 張殺必死/);assert.match(f.replies[1].content,/限定卡池券：2 張/);
 assert.match(f.replies[1].content,/不互相混用/);
});
test('一番賞正式面板含獨立查券列，不改原四個按鈕',async()=>{
 let payload;
 const db={from(){return {select(){return this;},order(){return this;},then(ok){return Promise.resolve({data:[]}).then(ok);}};},rpc:async()=>({data:[]})};
 const bot=createIchiban({supabase:db,enabled:true,client:{channels:{fetch:async()=>({isTextBased:()=>true,send:async p=>{payload=p;return{id:'test'};}})}},getPanelMessage:async()=>null,savePanelMessage:async()=>{}});
 await bot.publishPanel();assert.equal(payload.components[0].toJSON().components.length,4);
 assert.equal(payload.components[1].toJSON().components[0].custom_id,'qticket_balance:ichiban');
});
