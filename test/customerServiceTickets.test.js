const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { createCustomerServiceTickets, parseTicket, ticketTopic, panelPayload,
  GUILD_ID, PANEL_CHANNEL_ID, ARCHIVE_CHANNEL_ID, SUPPORT_ROLE_ID } = require('../events/customerServiceTickets');
const USER = '111111111111111111', BOT = '222222222222222222', TICKET = '333333333333333333', SAVED = '444444444444444444';
const values = rows => new Collection(rows.map(m => [m.id, m]));
function fixture(options = {}) {
  const sent = [], created = [], edits = [], topics = [], permissions = [], deleted = [];
  const logMessages = new Collection();
  const message = { id: '555555555555555555', createdTimestamp: 1000, author: { id: USER }, content: '需要協助' };
  const channelMessages = values([message]);
  const ticket = { id: TICKET, guildId: GUILD_ID, type: ChannelType.GuildText, name: '客服-測試',
    topic: ticketTopic({ owner: USER, kind: 'monthly', state: options.closed ? 'closed' : 'open' }),
    messages: { fetch: async ({ limit } = {}) => values([...channelMessages.values()].reverse().slice(0, limit || 100)) },
    permissionOverwrites: { edit: async (id, patch) => permissions.push({ id, patch }) },
    setTopic: async topic => { topics.push(topic); ticket.topic = topic; },
    send: async payload => { sent.push({ destination: TICKET, payload }); return { id: '666666666666666666' }; },
    delete: async () => { if (options.deleteError) throw Error('缺少刪除權限'); deleted.push(TICKET); },
  };
  const archive = { id: ARCHIVE_CHANNEL_ID, guildId: GUILD_ID, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => !options.noArchiveAccess }),
    messages: { fetch: async input => typeof input === 'string' ? logMessages.get(input) : logMessages },
    send: async payload => {
      if (options.archiveError) throw Error('上傳失敗');
      sent.push({ destination: ARCHIVE_CHANNEL_ID, payload });
      const saved = { id: SAVED, author: { id: BOT }, content: payload.content,
        attachments: options.noAttachment ? new Collection() : values([{ id: '777777777777777777' }]),
        edit: async payload => { edits.push(payload); return saved; } };
      logMessages.set(saved.id, saved);
      if (options.newMessage) channelMessages.set('888888888888888888', { id: '888888888888888888' });
      return saved;
    },
  };
  const panels = new Collection();
  const panel = { id: PANEL_CHANNEL_ID, guildId: GUILD_ID, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => panels },
    send: async payload => {
      const m = { id: '999999999999999999', author: { id: BOT },
        components: payload.components.map(x => ({ components: x.components.map(c => ({ customId: c.data.custom_id })) })),
        edit: async p => edits.push(p) };
      panels.set(m.id, m); sent.push({ destination: PANEL_CHANNEL_ID, payload }); return m;
    },
  };
  const channels = new Collection([[PANEL_CHANNEL_ID, panel], [ARCHIVE_CHANNEL_ID, archive]]);
  if (options.existing) channels.set(TICKET, ticket);
  const guild = { id: GUILD_ID, name: '秋奈', roles: { fetch: async () => ({ id: SUPPORT_ROLE_ID }) },
    channels: { fetch: async () => channels, create: async p => { created.push(p); channels.set(TICKET, ticket); return ticket; } } };
  const client = { user: { id: BOT }, channels: { fetch: async id => id === TICKET ? ticket : channels.get(id) } };
  const service = createCustomerServiceTickets({ client, isStaff: i => !!i.staff, resolveParent: async () => '1530875019851202851',
    fetchMessages: async () => options.tooMany ? Array(10000).fill(message) : [message],
    buildArchive: async () => options.tooLarge ? 'x'.repeat(1025) : '<html>完整客服紀錄</html>' });
  function interaction(customId = 'qcs_open', extra = {}) {
    return { id: '101010101010101010', customId, guildId: GUILD_ID, guild,
      channelId: customId === 'qcs_open' ? PANEL_CHANNEL_ID : TICKET, channel: ticket,
      user: { id: USER, username: 'test-user' }, values: ['monthly'],
      isStringSelectMenu: () => customId === 'qcs_open', isButton: () => customId !== 'qcs_open',
      deferReply: async () => {}, async editReply(p) { this.reply = p; }, ...extra };
  }
  return { service, interaction, sent, created, edits, topics, permissions, deleted, ticket, panels };
}
test('選單提供月結、合作、其他，不沿用其他機器人 custom_id', () => {
  const panel = panelPayload();
  assert.equal(panel.components[0].components[0].data.custom_id, 'qcs_open');
  assert.deepEqual(panel.components[0].components[0].options.map(x => x.data?.value || x.value), ['monthly', 'cooperation', 'other']);
  assert.equal(parseTicket('owner:111111111111111111'), null);
});
test('啟動重複發布只更新小奈自己的面板，不變動 Ticket Tool 訊息', async () => {
  const f = fixture();
  f.panels.set('old', { id: 'old', author: { id: 'other-bot' }, components: [] });
  const a = await f.service.ensurePanel(), b = await f.service.ensurePanel();
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(f.sent.length, 1); assert.equal(f.edits.length, 1); assert(f.panels.has('old'));
});
test('選完建立私人頻道、標註客服、顯示手刀與需求詢問；重複選取不另開單', async () => {
  const f = fixture(); const i = f.interaction();
  await f.service.handle(i); await f.service.handle(f.interaction());
  assert.equal(f.created.length, 1);
  const p = f.created[0];
  assert.equal(p.permissionOverwrites.find(x => x.id === GUILD_ID).deny[0], P.ViewChannel);
  const welcome = f.sent.find(x => x.payload.content?.includes('手刀'));
  assert(welcome.payload.content.includes(`<@&${SUPPORT_ROLE_ID}>`));
  assert.match(welcome.payload.content, /請問有什麼需要協助的/);
  assert.deepEqual(welcome.payload.allowedMentions.roles, [SUPPORT_ROLE_ID]);
  assert.match(i.reply.content, /已建立私人客服表單/);
});
test('同時點兩次選單只建立一次', async () => {
  const f = fixture();
  await Promise.all([f.service.handle(f.interaction()), f.service.handle(f.interaction())]);
  assert.equal(f.created.length, 1);
});
test('本人可關閉，只移除本人觀看及留言權限，不刪單；客服可重開', async () => {
  const f = fixture();
  await f.service.handle(f.interaction(`qcs_close_${TICKET}`));
  assert.equal(parseTicket(f.ticket.topic).state, 'closed');
  assert.deepEqual(f.permissions[0], { id: USER, patch: { ViewChannel: false, SendMessages: false } });
  assert.equal(f.deleted.length, 0);
  await f.service.handle(f.interaction(`qcs_reopen_${TICKET}`, { staff: true }));
  assert.equal(parseTicket(f.ticket.topic).state, 'open');
});
test('他人不能關閉，客人不能存檔刪除或重開', async () => {
  for (const operation of ['close', 'archive', 'reopen']) {
    const f = fixture({ closed: true });
    const i = f.interaction(`qcs_${operation}_${TICKET}`, operation === 'close' ? { user: { id: BOT } } : {});
    await f.service.handle(i); assert.match(i.reply.content, /只有客服/);
    assert.equal(f.topics.length, 0); assert.equal(f.deleted.length, 0);
  }
});
test('客服須先關閉；存檔必須送到指定頻道且驗證有附件後才刪除', async () => {
  const f = fixture(); const i = f.interaction(`qcs_archive_${TICKET}`, { staff: true });
  await f.service.handle(i); assert.match(i.reply.content, /請先關閉/); assert.equal(f.deleted.length, 0);
  f.ticket.topic = ticketTopic({ owner: USER, kind: 'monthly', state: 'closed' });
  await f.service.handle(i);
  assert.equal(f.sent[0].destination, ARCHIVE_CHANNEL_ID);
  assert.equal(f.sent[0].payload.files[0].name, `客服紀錄-${TICKET}.html`);
  assert.equal(parseTicket(f.ticket.topic).archive, SAVED);
  assert.equal(f.deleted.length, 1);
});
for (const key of ['archiveError', 'noAttachment', 'noArchiveAccess', 'tooMany', 'tooLarge', 'newMessage']) {
  test(`存檔未完整成功不刪除：${key}`, async () => {
    const f = fixture({ closed: true, [key]: true });
    const i = f.interaction(`qcs_archive_${TICKET}`, { staff: true, attachmentSizeLimit: 1024 });
    await f.service.handle(i); assert.match(i.reply.content, /^❌/); assert.equal(f.deleted.length, 0);
  });
}
test('刪除失敗後重試只更新原存檔，不重貼另一份', async () => {
  const f = fixture({ closed: true, deleteError: true });
  await f.service.handle(f.interaction(`qcs_archive_${TICKET}`, { staff: true }));
  await f.service.handle(f.interaction(`qcs_archive_${TICKET}`, { staff: true }));
  assert.equal(f.sent.filter(x => x.destination === ARCHIVE_CHANNEL_ID).length, 1);
  assert.equal(f.edits.length, 1); assert.equal(f.deleted.length, 0);
});
test('錯伺服器、錯頻道、非法業務及一般付款工單不處理', async () => {
  for (const extra of [{ guildId: BOT }, { channelId: TICKET }, { values: ['payment'] }]) {
    const f = fixture(); const i = f.interaction('qcs_open', extra);
    await f.service.handle(i); assert.match(i.reply.content, /^❌/); assert.equal(f.created.length, 0);
  }
  const f = fixture(); f.ticket.topic = 'owner:111111111111111111';
  await f.service.handle(f.interaction(`qcs_archive_${TICKET}`, { staff: true }));
  assert.equal(f.deleted.length, 0);
  assert.equal(await f.service.handle({ customId: 'complete_order' }), false);
});
