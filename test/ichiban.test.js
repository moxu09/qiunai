const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPanel, createIchiban, requestIdForInteraction } = require('../utils/ichiban');

test('一番賞面板顯示 ASD 價格、剩餘份數與網頁連結；未開放時不能抽', () => {
  const panel = buildPanel({
    prizes: [{ id: 's-airpods', tier: 'S', name: 'AirPods' }],
    stock: [{ prize_id: 's-airpods', remaining: 1 }],
    enabled: false,
  });
  const embed = panel.embeds[0].toJSON();
  const buttons = panel.components[0].toJSON().components;
  assert.match(embed.description, /300 ASD/);
  assert.match(embed.description, /AirPods：1/);
  assert.match(embed.description, /\/ichiban/);
  assert.equal(buttons[0].disabled, true);
});

test('一番賞未開放時點擊抽獎不呼叫扣款 RPC', async () => {
  let called = false;
  const bot = createIchiban({
    supabase: { rpc: async () => { called = true; return {}; } },
    client: {}, getPanelMessage: async () => null,
    savePanelMessage: async () => {}, enabled: false,
  });
  const replies = [];
  await bot.handle({
    isButton: () => true,
    customId: 'qiunai_ichiban_draw',
    reply: async (payload) => replies.push(payload),
  });
  assert.equal(called, false);
  assert.match(replies[0].content, /未扣除 ASD/);
});

test('同一次確認互動沿用同一冪等請求編號', () => {
  const id = requestIdForInteraction('1234567890123456789');
  assert.equal(id, requestIdForInteraction('1234567890123456789'));
  assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.notEqual(id, requestIdForInteraction('1234567890123456790'));
});
