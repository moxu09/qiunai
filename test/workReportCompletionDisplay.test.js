const test = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder } = require('discord.js');
const { buildUpdatedReportEmbed, createWorkReportSystem } = require('../events/workReportSystem');

const start = '2026-10-21T06:59:00.000Z';
const end = '2026-10-21T08:08:00.000Z';
function message() {
  return { embeds: [new EmbedBuilder().setTitle('訂單工時申報')
    .setDescription('請填寫開始與結束時間').addFields({ name: '金額', value: 'NT$300' })] };
}
function meta(minutes = 69, expected = 60) {
  return { expectedDurationMinutes: expected, endedAt: end, pendingSegmentStart: null,
    segments: [{ startedAt: start, endedAt: end, minutes }] };
}
for (const minutes of [60, 69]) {
  test(`預定60分鐘，已報${minutes}分鐘顯示已結束，但不宣稱薪資已核准`, () => {
    const embed = buildUpdatedReportEmbed(message(), meta(minutes)).toJSON();
    assert.match(embed.title, /已結束$/);
    assert.equal(embed.fields.find(f => f.name === '申報狀態').value, '已結束｜薪資待審核');
    assert.match(embed.description, /不代表薪資已核准或入帳/);
    assert(!embed.fields.some(f => f.name === '不足時長'));
    assert.equal(embed.fields.find(f => f.name === '金額').value, 'NT$300');
  });
}
test('未達預定時長不可顯示已結束', () => {
  const embed = buildUpdatedReportEmbed(message(), meta(59)).toJSON();
  assert.match(embed.title, /尚未結束$/);
  assert.equal(embed.fields.find(f => f.name === '不足時長').value, '0 小時 1 分鐘');
});
test('開始下一段後不能沿用上一段的結束狀態', () => {
  const embed = buildUpdatedReportEmbed(message(), { ...meta(), pendingSegmentStart: end }).toJSON();
  assert.match(embed.title, /進行中$/);
  assert.match(embed.fields.find(f => f.name === '申報狀態').value, /等待結束時間/);
});
test('多段累積達標、無額定時長及客服提早結單各自顯示已結束', () => {
  for (const value of [meta(60, 0), { ...meta(20), closedEarly: true },
    { ...meta(), segments: [meta(30).segments[0], meta(39).segments[0]] }]) {
    assert.match(buildUpdatedReportEmbed(message(), value).toJSON().title, /已結束$/);
  }
});
test('重繪不會重複新增狀態欄位或標題後綴', () => {
  const first = buildUpdatedReportEmbed(message(), meta());
  const second = buildUpdatedReportEmbed({ embeds: [first] }, meta()).toJSON();
  assert.equal(second.title, '訂單工時申報｜已結束');
  assert.equal(second.fields.filter(f => f.name === '申報狀態').length, 1);
});

function fixture(failPanel = false) {
  const calls = []; let payload;
  const row = { id: 'report', discord_id: 'staff', status: '工時待填',
    admin_note: JSON.stringify({ expectedDurationMinutes: 60, pendingSegmentStart: start, segments: [] }) };
  const query = { select() { return this; }, eq() { return this; },
    update(value) { payload = value; calls.push('save'); return this; },
    async maybeSingle() { return { data: payload ? { ...row, ...payload } : row, error: null }; } };
  const interaction = { customId: 'submit_work_report_end_report', user: {id:'staff'},
    isButton: () => false, isModalSubmit: () => true, isUserSelectMenu: () => false,
    fields: { getTextInputValue: () => '2026-10-21 16:08' },
    async deferReply() { calls.push('defer'); this.deferred = true; },
    async editReply(value) { this.result = value.content; },
    message: { ...message(), async edit(value) { interaction.panel = value; if (failPanel) throw Error('Discord timeout'); } },
  };
  const system = createWorkReportSystem({ supabase: { from: () => query }, client: {}, appKey: 'qiunai', salaryTable: 'qiunai_salary_orders' });
  return { system, interaction, calls, payload: () => payload };
}
test('結束時間送出後，公開報單同步顯示已結束且移除報時按鈕，維持待審核', async () => {
  const f = fixture(); await f.system.handleInteraction(f.interaction);
  assert.equal(f.calls[0], 'defer');
  assert.equal(f.payload().status, '工時待審核');
  assert.equal(JSON.parse(f.payload().admin_note).durationMinutes, 69);
  assert.match(f.interaction.panel.content, /本筆服務已結束/);
  assert.match(f.interaction.panel.embeds[0].toJSON().title, /已結束$/);
  assert(!JSON.stringify(f.interaction.panel.components).match(/work_report_(?:start|end)_/));
});
test('Discord面板更新失敗仍告知已儲存，不能靜默失敗或重複寫入', async () => {
  const f = fixture(true); await f.system.handleInteraction(f.interaction);
  assert.equal(f.calls.filter(x => x === 'save').length, 1);
  assert.match(f.interaction.result, /畫面暫時更新失敗.*請勿重複報時/);
});
