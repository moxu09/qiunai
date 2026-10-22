const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { handleManualPointDeduction } = require('../utils/manualPointDeduction');
function fixture(patch = {}) {
  const replies = []; let calls = 0, sent = 0;
  const interaction = { id: '1561500000000000001', guildId: '1206138511535898654', channelId: '1561500000000000002',
    user: { id: '847840193859682304' }, guild: { members: { fetch: async () => ({}) } },
    options: { getUser: () => ({ id: '1024589023144058902', bot: false }), getNumber: () => 12.34, getString: () => ' 更正重複回饋 ' },
    editReply: async p => { replies.push(p); return p; }, ...patch };
  const data = { applied: true, already_applied: false, requested_points: 12.34, balance_before: 100, balance_after: 87.66 };
  const deps = { isAuthorized: () => true, db: { rpc: async (name, args) => {
    calls++; assert.equal(name, 'qiunai_deduct_manual_points');
    assert.deepEqual(args, { p_operation_key: `manual-point-deduction:${interaction.id}`, p_guild_id: interaction.guildId,
      p_user_id: '1024589023144058902', p_actor_id: interaction.user.id, p_channel_id: interaction.channelId,
      p_points: 12.34, p_reason: '更正重複回饋' }); return { data };
  } }, notify: async (_, p) => { sent++; assert.deepEqual(p.allowedMentions, { parse: [] }); } };
  return { interaction, deps, replies, data, get calls() { return calls; }, get sent() { return sent; } };
}
test('扣點僅限秋奈授權人員，拒絕私訊、異群與公開前綴', async () => {
  for (const patch of [{ guildId: null }, { guildId: 'other' }, { isPrefixCommand: true }, {}]) {
    const f = fixture(patch); if (!Object.keys(patch).length) f.deps.isAuthorized = () => false;
    await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.calls, 0); assert.equal(f.sent, 0);
  }
});
test('扣點兩位小數並記錄操作人、原因與前後餘額，禁止提及通知', async () => {
  const f = fixture(); await handleManualPointDeduction(f.interaction, f.deps);
  assert.equal(f.calls, 1); assert.equal(f.sent, 1);
  assert.match(f.replies[0].content, /扣除：12.34 點｜扣除前：100 點｜扣除後可用：87.66 點/);
  assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
});
test('扣點拒絕無效金額與空白或過長原因', async () => {
  for (const points of [0, -1, NaN, Infinity, 1000001, 0.001, 1.234]) {
    const f = fixture(); f.interaction.options.getNumber = () => points;
    await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.calls, 0);
  }
  for (const reason of ['', '  ', '字'.repeat(201), null]) {
    const f = fixture(); f.interaction.options.getString = () => reason;
    await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.calls, 0);
  }
});
test('扣點拒絕機器人或無法確認會員身分的對象', async () => {
  for (const bot of [true, false]) {
    const f = fixture(); if (bot) f.interaction.options.getUser = () => ({ bot: true });
    else f.interaction.guild.members.fetch = async () => { throw Error('offline'); };
    await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.calls, 0);
  }
});
test('扣點不足不回報成功也不發私訊', async () => {
  const f = fixture(); Object.assign(f.data, { applied: false, reason: 'insufficient_points', available_points: 5 });
  await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.sent, 0);
  assert.match(f.replies[0].content, /可用點數不足，未扣除/); assert.match(f.replies[0].content, /目前可用：5 點/);
});
test('同一請求重試不重寄通知，私訊失敗不重扣', async () => {
  const f = fixture(); f.data.already_applied = true;
  await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.sent, 0); assert.match(f.replies[0].content, /未重複扣除/);
  const g = fixture(); g.deps.notify = async () => { throw Error('blocked'); };
  await handleManualPointDeduction(g.interaction, g.deps); assert.equal(g.calls, 1); assert.match(g.replies[0].content, /已扣除，但私訊無法送達/);
});
test('網路或資料庫錯誤不宣稱未扣款，保留編號防止另開指令重複扣除', async () => {
  for (const rpc of [async () => ({ error: Error('offline') }), async () => { throw Error('timeout'); }, async () => ({ data: null })]) {
    const f = fixture(); f.deps.db.rpc = rpc;
    await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.sent, 0);
    assert.match(f.replies[0].content, /未能確認扣除結果/); assert.match(f.replies[0].content, /manual-point-deduction:/);
    assert.doesNotMatch(f.replies[0].content, /✅|未扣除點數/);
  }
});
test('未知RPC結果不可冒充成功', async () => {
  const f = fixture(); f.deps.db.rpc = async () => ({ data: {} });
  await handleManualPointDeduction(f.interaction, f.deps); assert.equal(f.sent, 0); assert.match(f.replies[0].content, /結果異常/);
});
test('註冊扣點指令及處理器，沿用私密延遲回覆', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(source, /setName\("扣除消費點數"\)/);
  assert.match(source, /commandName === "扣除消費點數"[\s\S]*?handleManualPointDeduction/);
  assert.match(source, /deferReply\(\{\s*flags: 64/);
});
