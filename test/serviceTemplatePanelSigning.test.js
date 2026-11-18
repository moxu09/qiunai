const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceTemplatePanel } = require('../utils/serviceTemplatePanel.cjs');

const guildId = '1513174069087047731';
const channelId = '1566885603637854269';
const actorId = '123456789012345678';
const staffRoleId = '1513203868895412305';
const targetId = '987654321098765432';

function fixture(initialRole = 'store_manager', extraBroadcast = 0) {
  const state = { role: initialRole, sent: [], resends: [], replies: [] };
  const templates = [
    ['guide-bot', '操作', '請老闆開單'],
    ['ask-accept', '操作', '詢問能否接單'],
    ['ask-review', '操作', '請老闆留好評'],
    ['handover-line', '操作', '交接班'],
    ['clock-in-out', '操作', '上下班打卡'],
    ['gift-broadcast', '播報', '禮物播報'],
  ].map(([slug, category, title]) => ({
    id: slug, slug, category, title, organization_code: 'qiunai',
    is_active: true, version: 1, body: title, fields: [],
  }));
  for (let index = 0; index < extraBroadcast; index++) templates.push({
    id: `broadcast-${index}`, slug: `broadcast-${index}`, category: '播報',
    title: `播報模板 ${index}`, organization_code: 'qiunai',
    is_active: true, version: 1, body: `播報模板 ${index}`, fields: [],
  });
  const supabase = {
    rpc: async () => ({ data: { guild_id: guildId, channel_id: channelId, message_id: null }, error: null }),
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
  const message = { author: { id: '222222222222222222' },
    embeds: [{ footer: { text: '秋奈電競客服工具・確認內容後再貼上' } }],
  };
  const channel = { guildId, isTextBased: () => true,
    messages: { fetch: async () => new Map() },
    async send(payload) { state.sent.push(payload); return { id: '555555555555555555' }; },
  };
  const client = { user: { id: message.author.id }, channels: { fetch: async () => channel } };
  const panel = createServiceTemplatePanel({ client, supabase, organization: 'qiunai',
    tipGifts: [{ key: 'gift', name: '小禮物', price: 100 }],
    resendSigning: async (...args) => { state.resends.push(args); return 'sent'; },
  });
  function interaction(customId, overrides = {}) {
    return {
      customId, guildId, channelId, message,
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
  return { panel, state, interaction };
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
