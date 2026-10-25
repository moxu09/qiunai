const test = require('node:test');
const assert = require('node:assert/strict');
const { handleManualDrawTickets } = require('../utils/manualDrawTickets');
function fixture(patch = {}) {
  const calls = [], replies = [], notices = [];
  const interaction = { id: '1561934597594423396', guildId: '1206138511535898654', channelId: '1561934204600844319', user: { id: '847840193859682304' },
    guild: { members: { fetch: async () => ({}) } },
    options: { getUser: () => ({ id: '1247538400844583016', bot: false }), getInteger: () => 2, getString: name => name === '券種' ? 'kill' : '人工抽獎核銷' },
    editReply: async payload => { replies.push(payload); return payload; }, ...patch };
  const deps = { isAuthorized: () => true, db: { rpc: async (name, args) => { calls.push({ name, args }); return { data: { remaining_count: 1, already_applied: false } }; } }, notify: async (_, payload) => notices.push(payload) };
  return { interaction, deps, calls, replies, notices, run: () => handleManualDrawTickets(interaction, deps) };
}
test('只允許秋奈客服或管理員透過 slash 核銷', async () => {
  for (const patch of [{ guildId: null }, { guildId: '1501098191813214312' }, { isPrefixCommand: true }, {}]) {
    const f = fixture(patch); if (!Object.keys(patch).length) f.deps.isAuthorized = () => false;
    await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
  }
});
test('原子核銷帶入操作者、券種、數量、原因及 interaction 防重複鍵', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.calls[0].name, 'qiunai_redeem_manual_draw_tickets');
  assert.equal(f.calls[0].args.p_operation_key, 'manual-draw-ticket:1561934597594423396');
  assert.equal(f.calls[0].args.p_actor_id, f.interaction.user.id);
  assert.equal(f.calls[0].args.p_ticket_kind, 'kill'); assert.equal(f.calls[0].args.p_ticket_count, 2);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].enforceNonce, true);
  assert.match(f.replies[0].content, /剩餘：1 張/); assert.match(f.replies[0].content, /不會自動抽獎或扣錢包/);
  assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
});
test('省略數量預設一張，三種券各自核銷', async () => {
  for (const kind of ['kill', 'ichiban', 'limited']) {
    const f = fixture(); f.interaction.options.getInteger = () => null;
    f.interaction.options.getString = name => name === '券種' ? kind : '核銷';
    await f.run(); assert.equal(f.calls[0].args.p_ticket_count, 1); assert.equal(f.calls[0].args.p_ticket_kind, kind);
  }
});
test('無效券種、數量、空白備註、機器人或離群一律不扣券', async () => {
  for (const count of [0, -1, 21, 1.5, NaN]) { const f = fixture(); f.interaction.options.getInteger = () => count; await f.run(); assert.equal(f.calls.length, 0); }
  for (const strings of [{ 券種: 'bad', 備註: '核銷' }, { 券種: 'kill', 備註: ' ' }]) { const f = fixture(); f.interaction.options.getString = name => strings[name]; await f.run(); assert.equal(f.calls.length, 0); }
  const bot = fixture(); bot.interaction.options.getUser = () => ({ id: 'bot', bot: true }); await bot.run(); assert.equal(bot.calls.length, 0);
  const gone = fixture(); gone.interaction.guild.members.fetch = async () => { throw Error('gone'); }; await gone.run(); assert.equal(gone.calls.length, 0);
});
test('券不足不通知成功，網路錯誤不誤稱未扣券', async () => {
  const f = fixture(); f.deps.db.rpc = async () => ({ error: { message: '抽獎券不足' } }); await f.run();
  assert.equal(f.notices.length, 0); assert.match(f.replies[0].content, /未扣除任何券/);
  const g = fixture(); g.deps.db.rpc = async () => ({ error: { message: 'timeout' } }); await g.run();
  assert.match(g.replies[0].content, /結果暫時無法確認/); assert.doesNotMatch(g.replies[0].content, /未扣除/);
});
test('重試不重扣也不重寄；私訊失敗仍回報核銷成功', async () => {
  const f = fixture(); f.deps.db.rpc = async () => ({ data: { remaining_count: 1, already_applied: true } }); await f.run(); assert.equal(f.notices.length, 0); assert.match(f.replies[0].content, /未再次扣券/);
  const g = fixture(); g.deps.notify = async () => { throw Error('blocked'); }; await g.run(); assert.equal(g.calls.length, 1); assert.match(g.replies[0].content, /核銷成功，但客人私訊無法送達/);
});
