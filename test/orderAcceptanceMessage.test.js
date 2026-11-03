const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptanceState, createAcceptanceMessageSync } = require('../utils/orderAcceptanceMessage');
const base = { paid: true, status: 'pending', assigned_player: null, player_count: 2 };
function message() {
  return { components: [{ type: 1, components: [
    { type: 2, custom_id: 'accept_play_order_o', style: 3, label: '接單' },
    { type: 2, custom_id: 'other', style: 2, label: '其他' },
  ] }], edits: [], async edit(value) { this.edits.push(value); } };
}
test('多人未滿顯示剩餘名額，額滿與失效訂單停用，重複 ID 不重算', () => {
  assert.deepEqual(acceptanceState({ ...base, assigned_player: 'a,a' }), { count: 1, required: 2, disabled: false, label: '接單（1/2，剩 1 位）' });
  assert.equal(acceptanceState({ ...base, assigned_player: 'a,b' }).label, '已接單');
  assert.equal(acceptanceState({ ...base, assigned_player: 'a,b' }).disabled, true);
  assert.equal(acceptanceState({ ...base, status: 'cancelled' }).disabled, true);
  assert.equal(acceptanceState({ ...base, paid: false }).disabled, true);
});
test('只更新原卡片對應按鈕，不改其他按鈕或重發訊息', async () => {
  const m = message();
  await createAcceptanceMessageSync({ loadOrder: async () => ({ ...base, assigned_player: 'a,b' }) })(m, 'o');
  const components = m.edits[0].components[0].toJSON().components;
  assert.equal(components[0].label, '已接單'); assert.equal(components[0].disabled, true);
  assert.equal(components[1].label, '其他'); assert.deepEqual(Object.keys(m.edits[0]), ['components']);
});
test('送出部分名額更新期間最後一人接單，最終重新讀取並停用', async () => {
  let current = { ...base, assigned_player: 'a' }; const m = message();
  m.edit = async value => { m.edits.push(value); current = { ...current, assigned_player: 'a,b' }; };
  const sync = createAcceptanceMessageSync({ loadOrder: async () => current });
  await Promise.all([sync(m, 'o'), sync(m, 'o')]);
  const last = m.edits.at(-1).components[0].toJSON().components[0];
  assert.equal(last.label, '已接單'); assert.equal(last.disabled, true);
});
test('Discord 暫時編輯失敗會重試，資料庫錯誤不使用舊名單重開按鈕', async () => {
  const m = message(); let attempts = 0;
  m.edit = async value => { if (++attempts === 1) throw Error('network'); m.edits.push(value); };
  await createAcceptanceMessageSync({ loadOrder: async () => ({ ...base, assigned_player: 'a,b' }) })(m, 'o');
  assert.equal(attempts, 2); assert.equal(m.edits.length, 1);
  const failed = message(); await assert.rejects(createAcceptanceMessageSync({ loadOrder: async () => { throw Error('database'); } })(failed, 'o'), /database/);
  assert.equal(failed.edits.length, 0);
});
