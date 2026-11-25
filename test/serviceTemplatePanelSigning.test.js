const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceTemplatePanel } = require('../utils/serviceTemplatePanel.cjs');

const guildId = '1513174069087047731';
const channelId = '1566885603637854269';
const actorId = '123456789012345678';
const staffRoleId = '1513203868895412305';
const targetId = '987654321098765432';

function fixture(initialRole = 'store_manager', extraBroadcast = 0, organization = 'qiunai') {
  const fixtureGuildId = organization === 'qiunai' ? guildId : '1501836172199202856';
  const fixtureChannelId = organization === 'qiunai' ? channelId : '1566890399765762208';
  const state = { role: initialRole, sent: [], edited: [], resends: [], replies: [] };
  const templates = [
    ['guide-bot', '操作', '請老闆開單'],
    ['ask-accept', '操作', '詢問能否接單'],
    ['ask-review', '操作', '請老闆留好評'],
    ['handover-line', '操作', '交接班'],
    ['clock-in-out', '操作', '上下班打卡'],
    ['gift-broadcast', '播報', '禮物播報'],
  ].map(([slug, category, title]) => ({
    id: slug, slug, category, title, organization_code: organization,
    is_active: true, version: 1, body: title, fields: [],
  }));
  for (let index = 0; index < extraBroadcast; index++) templates.push({
    id: `broadcast-${index}`, slug: `broadcast-${index}`, category: '播報',
    title: `播報模板 ${index}`, organization_code: organization,
    is_active: true, version: 1, body: `播報模板 ${index}`, fields: [],
  });
  const supabase = {
    rpc: async () => ({ data: { guild_id: fixtureGuildId, channel_id: fixtureChannelId, message_id: null }, error: null }),
    from(table) {
      if (table === 'service_templates') return {
        select() { return this; }, eq() { return this; },
        async order() { return { data: templates, error: null }; },
      };
      if (table === 'erp_role_assignments') return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { role: state.role, is_active: true }, error: null }; },
      };
      if (table === 'qiunai_staff') return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: { discord_id: actorId, is_active: true }, error: null }; },
      };
      if (table === 'service_panel_registry') return {
        update() { return this; }, eq() { return this; }, gt() { return this; },
        async select() { return { data: [{ message_id: '555555555555555555' }], error: null }; },
        then(resolve) { resolve({ data: null, error: null }); },
      };
      throw Error(`Unexpected table: ${table}`);
    },
  };
  const message = { id: '555555555555555555', author: { id: '222222222222222222' },
    embeds: [{ footer: { text: organization === 'qiunai' ? '秋奈電競客服工具・確認內容後再貼上' : '深夜不關燈客服工具・確認內容後再貼上' } }],
    async edit(payload) { state.edited.push(payload); return this; },
  };
  const channel = { guildId: fixtureGuildId, isTextBased: () => true,
    messages: { fetch: async () => new Map() },
    async send(payload) { state.sent.push(payload); return { id: '555555555555555555' }; },
  };
  const client = { user: { id: message.author.id }, channels: { fetch: async () => channel } };
  const panel = createServiceTemplatePanel({ client, supabase, organization,
    tipGifts: [{ key: 'gift', name: '小禮物', price: 100 }],
    resendSigning: async (...args) => { state.resends.push(args); return 'sent'; },
  });
  function interaction(customId, overrides = {}) {
    return {
      customId, guildId: fixtureGuildId, channelId: fixtureChannelId, message,
      user: { id: actorId }, member: { roles: [staffRoleId] },
      memberPermissions: { has: () => false },
      isButton: () => customId === 'svc:signing-resend',
      isModalSubmit: () => customId.startsWith('svc:signing-submit:'),
      fields: { getTextInputValue: () => targetId },
      async showModal(value) { state.modal = value; },
      async deferReply() { this.deferred = true; },
      async reply(value) { state.replies.push(value); },
      async editReply(value) { state.replies.push(value); },
      ...overrides,
    };
  }
  return { panel, state, interaction, channel, message };
}

test('秋奈客服面板保留模板並顯示重發按鈕，符合 Discord 五列限制', async () => {
  const f = fixture();
  await f.panel.ensurePanel();
  const rows = f.state.sent[0].components;
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.components.length <= 5));
  assert.ok(rows.flatMap(row => row.components).some(component =>
    component.custom_id === 'svc:signing-resend' && component.label === '重發簽約連結'));
  assert.ok(rows.flatMap(row => row.components).some(component => component.custom_id === 'svc:gift'));
  for (const [id, label] of [
    ['open_manual_work_report_order', '手動訂單報單'],
    ['open_manual_work_report_gift', '手動打賞報單'],
  ]) {
    assert.equal(rows.flatMap(row => row.components).filter(component => component.custom_id === id && component.label === label).length, 1);
  }
});

test('秋奈主面板的手動報單入口交給現有處理器並開啟正確表單', async () => {
  const { createWorkReportSystem } = require('../events/workReportSystem');
  const workReports = createWorkReportSystem({
    supabase: { from() { throw Error('Opening a modal must not write payroll'); } },
    client: {}, appKey: 'qiunai', guildId, manualChannelId: channelId,
    staffTable: 'qiunai_staff', staffRoleId, customerServiceRoleId: staffRoleId,
    salaryTable: 'qiunai_salary_orders',
  });
  const f = fixture();
  for (const kind of ['order', 'gift']) {
    f.state.modal = null;
    const i = f.interaction(`open_manual_work_report_${kind}`, {
      isButton: () => true, isModalSubmit: () => false,
      async deferReply() { throw Error('Opening a modal must not be deferred'); },
    });
    assert.equal(await f.panel.handleInteraction(i), false);
    assert.equal(await workReports.handleInteraction(i), true);
    const modal = f.state.modal.toJSON();
    assert.equal(modal.custom_id, `submit_manual_work_report_${kind}`);
    assert.equal(modal.title, kind === 'order' ? '訂單報單' : '打賞報單');
    const fields = modal.components.flatMap(row => row.components.map(field => field.custom_id));
    assert.equal(fields.includes('manual_duration'), kind === 'order');
    assert.ok(fields.includes('manual_staff'));
  }
  f.state.modal = null;
  await workReports.handleInteraction(f.interaction('open_manual_work_report_order', {
    member: { roles: [] }, isButton: () => true, isModalSubmit: () => false,
  }));
  assert.equal(f.state.modal, null);
  assert.match(f.state.replies.at(-1).content, /只有客服或管理員/);
});

test('深夜面板不加入秋奈的手動報單或重發簽約入口', async () => {
  const f = fixture('store_manager', 0, 'deepnight');
  await f.panel.ensurePanel();
  const rows = f.state.sent[0].components;
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.components.length <= 5));
  const controls = rows.flatMap(row => row.components);
  assert.equal(controls.filter(control => control.custom_id.startsWith('open_manual_work_report')).length, 0);
  assert.equal(controls.filter(control => control.custom_id === 'svc:signing-resend').length, 0);
  assert.equal(controls.filter(control => control.custom_id.startsWith('svc:quick:')).length, 5);
});

test('重建客服面板會更新既有訊息而不重複新增', async () => {
  const f = fixture();
  f.channel.messages.fetch = async () => new Map([[f.message.id, f.message]]);
  assert.equal(await f.panel.ensurePanel(), f.message.id);
  assert.equal(f.state.sent.length, 0);
  assert.equal(f.state.edited.length, 1);
  assert.ok(f.state.edited[0].components.flatMap(row => row.components)
    .some(control => control.custom_id === 'open_manual_work_report_order'));
});

test('主管可輸入 ID 重發，一般員工不能使用或偽造提交', async () => {
  const f = fixture();
  await f.panel.handleInteraction(f.interaction('svc:signing-resend'));
  assert.equal(f.state.modal.title, '重發簽約連結');
  await f.panel.handleInteraction(f.interaction(`svc:signing-submit:${actorId}`));
  assert.deepEqual(f.state.resends, [[targetId, actorId]]);
  assert.match(f.state.replies.at(-1).content, /已將新的簽約連結私訊/);

  f.state.role = 'employee';
  f.state.modal = null;
  await f.panel.handleInteraction(f.interaction('svc:signing-resend'));
  assert.equal(f.state.modal, null);
  assert.match(f.state.replies.at(-1).content, /只有客服與主管/);
  await f.panel.handleInteraction(f.interaction(`svc:signing-submit:${actorId}`));
  assert.equal(f.state.resends.length, 1);
  assert.match(f.state.replies.at(-1).content, /只有客服與主管/);
});

test('播報模板超過 25 筆時仍能選到下一頁與訂單協助模板', async () => {
  const f = fixture('store_manager', 30);
  await f.panel.ensurePanel();
  const rows = f.state.sent[0].components;
  assert.equal(rows.length, 5);
  const menus = rows.flatMap(row => row.components).filter(component => component.type === 3);
  assert.ok(menus.some(menu => menu.custom_id === 'svc:template:other:0'));
  assert.ok(menus.some(menu => menu.custom_id === 'svc:template:broadcast:0' &&
    menu.options.some(option => option.value === 'page:broadcast:1')));

  const i = f.interaction('svc:template:broadcast:0', {
    message: { author: { id: 'other' }, embeds: [] },
    values: ['page:broadcast:1'],
    isStringSelectMenu: () => true,
  });
  await f.panel.handleInteraction(i);
  assert.ok(f.state.replies.at(-1).components[0].components[0].options
    .some(option => option.value === 'broadcast-29'));
});
