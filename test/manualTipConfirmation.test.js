const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");
const { buildConfirmedTipEmbed, recoverManualTip } = require("../utils/manualTipConfirmation");
const { buildTipAllocations } = require("../utils/tips");
const gifts = [{key:"cookie", name:"小熊棉花糖餅乾",price:33}];
function fixture(count = 17) {
  const ids = Array.from({length:count},(_,i)=>String(480730947629875200n+BigInt(i)));
  const embed = new EmbedBuilder().setTitle("💝 打賞需求").addFields(
    {name:"打賞人",value:"<@973236155019579442>"},
    {name:"受賞陪陪",value:ids.map(id=>`<@${id}>`).join("、")},
    {name:"打賞明細",value:ids.map(id=>`<@${id}>：小熊棉花糖餅乾×1｜33 ASD`).join("\n")},
    {name:"總金額",value:`NT$${33*count}`}, {name:"付款方式",value:"匯款"},
    {name:"付款狀態",value:"等待客服確認付款"});
  return { author:{id:"bot"},embeds:[embed.toJSON()],channelId:"channel",guildId:"guild",createdTimestamp:2000 };
}
test("17人561元確認不再重複塞入超過1024字元的欄位，保留原始明細",()=>{
  const original=fixture().embeds[0];
  const result=buildConfirmedTipEmbed(original,"847840193859682304").toJSON();
  assert.ok(result.fields.every(field=>field.value.length<=1024));
  assert.equal(result.fields.find(x=>x.name==="打賞明細").value,original.fields.find(x=>x.name==="打賞明細").value);
  assert.equal(result.fields.filter(x=>x.name==="付款狀態").length,1);
});
test("重啟後可從機器人原訊息驗證重建17筆，不會自動標成付款",()=>{
  const recovered=recoverManualTip(fixture(),"973236155019579442_1000","bot",gifts);
  assert.ok(recovered);
  const allocations=buildTipAllocations(recovered);
  assert.equal(allocations.length,17);
  assert.equal(allocations.reduce((sum,x)=>sum+x.amount,0),561);
  assert.equal(recovered.paid,undefined);
});
test("拒絕偽造來源、錯誤付款人、不完整明細、被修改總額",()=>{
  const flow="973236155019579442_1000";
  assert.equal(recoverManualTip(fixture(),flow,"otherbot",gifts),null);
  assert.equal(recoverManualTip(fixture(),"other_1000","bot",gifts),null);
  const m=fixture();m.embeds[0].fields.find(x=>x.name==="總金額").value="NT$600";
  assert.equal(recoverManualTip(m,flow,"bot",gifts),null);
  const incomplete=fixture();incomplete.embeds[0].fields.find(x=>x.name==="打賞明細").value+="…";
  assert.equal(recoverManualTip(incomplete,flow,"bot",gifts),null);
});
