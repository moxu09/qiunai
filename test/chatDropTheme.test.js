const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildChatDropPayload, chatDropClaimText } = require("../utils/chatDropTheme");
const { shouldCreateChatDrop, CHAT_DROP_PROBABILITY } = require("../utils/randomEvents");
test("聊天掉落精確採用1%門檻", () => {
  assert.equal(CHAT_DROP_PROBABILITY, 0.01);
  for (const value of [0, 0.005, 0.009999]) assert.equal(shouldCreateChatDrop(value), true);
  for (const value of [0.01, 0.025, 1, -1, NaN, Infinity]) assert.equal(shouldCreateChatDrop(value), false);
});
test("萬聖節卡片保留原領取協定，1至20 ASD皆可領取且圖片真實存在", () => {
  for (const reward of [1, 18, 20]) {
    const p = buildChatDropPayload(reward);
    assert.equal(p.components[0].components[0].data.custom_id, `claim_${reward}`);
    assert.match(p.embeds[0].data.description, new RegExp(`\\*\\*${reward} ASD\\*\\*`));
    assert.equal(p.embeds[0].data.image.url, `attachment://${p.files[0].name}`);
    assert.equal(fs.readFileSync(p.files[0].attachment).subarray(1, 4).toString(), "PNG");
  }
  for (const reward of [0, 21, -1, 1.5, "18"]) assert.throws(() => buildChatDropPayload(reward));
});
test("新掉落顯示萬聖節領取結果，舊掉落仍維持原回覆", () => {
  const p = buildChatDropPayload(18);
  assert.match(chatDropClaimText({ embeds: p.embeds.map(e => e.toJSON()) }, 18), /南瓜糖果袋領取了 18 ASD/);
  assert.equal(chatDropClaimText({ embeds: [] }, 5), "☔ 成功領取 5 星雨幣");
});
