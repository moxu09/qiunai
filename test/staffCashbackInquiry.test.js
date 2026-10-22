const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {handleStaffCashbackInquiry} = require('../utils/staffCashbackInquiry');

function fixture(patch={}) {
  const replies=[], reads=[];
  const interaction={guildId:'1206138511535898654',guild:{members:{fetch:async()=>({})}},
    user:{id:'staff'},options:{getUser:()=>({id:'1024589023144058902',bot:false})},
    editReply:async p=>{replies.push(p);return p;},...patch};
  const db={rpc(){throw Error('查詢不可發放');},from(){throw Error('測試應只走查詢函式');}};
  const deps={db,isAuthorized:()=>true,readSummary:async(d,id)=>{assert.equal(d,db);reads.push(id);return '💠 我的消費點數\n目前可用：12.34 點\n最近十筆回饋\n2026/10/19 11:00｜人工回饋｜+12.34 點';}};
  return {interaction,deps,replies,reads};
}
test('客服指定會員只查該會員，顯示小數餘額及回饋明細',async()=>{
  const f=fixture();await handleStaffCashbackInquiry(f.interaction,f.deps);
  assert.deepEqual(f.reads,['1024589023144058902']);
  const text=f.replies[0].embeds[0].description;
  assert.match(text,/1024589023144058902/);assert.match(text,/12.34 點/);assert.match(text,/最近十筆回饋/);assert.match(text,/人工回饋/);
  assert.deepEqual(f.replies[0].allowedMentions,{parse:[]});
});
test('一般會員、異店與私訊不得讀取任何點數',async()=>{
  for(const patch of [{guildId:'other'},{guildId:null},{}]) {
    const f=fixture(patch);if(!Object.keys(patch).length)f.deps.isAuthorized=()=>false;
    await handleStaffCashbackInquiry(f.interaction,f.deps);assert.equal(f.reads.length,0);
  }
});
test('公開的驚嘆號指令不可洩露會員財務資料',async()=>{
  const f=fixture({isPrefixCommand:true});await handleStaffCashbackInquiry(f.interaction,f.deps);
  assert.equal(f.reads.length,0);assert.match(f.replies[0].content,/私密/);
});
test('機器人與無法核實本群成員不能查詢',async()=>{
  for(const bot of [true,false]) {
    const f=fixture();if(bot)f.interaction.options.getUser=()=>({bot:true});
    else f.interaction.guild.members.fetch=async()=>{throw Error('Unknown Member');};
    await handleStaffCashbackInquiry(f.interaction,f.deps);assert.equal(f.reads.length,0);
  }
});
test('資料庫失敗明確顯示失敗而非零點',async()=>{
  const f=fixture();f.deps.readSummary=async()=>{throw Error('offline');};
  await handleStaffCashbackInquiry(f.interaction,f.deps);
  assert.match(f.replies[0].content,/暫時無法讀取/);assert.doesNotMatch(f.replies[0].content,/目前可用：0/);
});
test('指令註冊為必填會員，並沿用私密Slash回覆路徑',()=>{
  const source=fs.readFileSync(require.resolve('../index'),'utf8');
  assert.match(source,/setName\("查看回饋點數"\)[\s\S]*?setName\("玩家"\)[^\n]*setRequired\(true\)/);
  assert.match(source,/if \(interaction.commandName === "查看回饋點數"\)/);
  assert.match(source,/else \{\s*await interaction.deferReply\(\{ flags: 64 \}\)/);
});
