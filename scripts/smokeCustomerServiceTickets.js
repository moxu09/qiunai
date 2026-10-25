// One private live smoke ticket. Never publishes a panel or pings customer service.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { Client, Events, GatewayIntentBits, PermissionFlagsBits: P } = require('discord.js');
const { createCustomerServiceTickets, parseTicket, GUILD_ID, PANEL_CHANNEL_ID, ARCHIVE_CHANNEL_ID } = require('../events/customerServiceTickets');
if (!process.argv.includes('--apply')) throw new Error('This creates one private test ticket; requires --apply');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let createdId;
(async () => {
  const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));
  await client.login(process.env.TOKEN); await ready;
  const guild = await client.guilds.fetch(GUILD_ID);
  const before = await guild.channels.fetch();
  assert(![...before.values()].some(c => parseTicket(c?.topic)?.owner === guild.ownerId), 'Owner already has a ticket; aborting smoke');
  const originalCreate = guild.channels.create.bind(guild.channels);
  let creates = 0;
  guild.channels.create = async payload => {
    assert.equal(payload.type, 0);
    const channel = await originalCreate(payload); createdId = channel.id; creates++;
    const originalSend = channel.send.bind(channel);
    channel.send = payload => originalSend({ ...payload, allowedMentions: { parse: [] } });
    return channel;
  };
  const system = createCustomerServiceTickets({ client, isStaff: i => i.user.id === guild.ownerId,
    resolveParent: async () => {
      const category = before.get('1530875019851202851');
      assert(category && [...before.values()].filter(c => c?.parentId === category.id).length < 50, 'No room in validated test category');
      return category.id;
    } });
  let replies = [];
  const interaction = customId => ({ id: '100000000000000001', customId, guild, guildId: GUILD_ID,
    channelId: customId === 'qcs_open' ? PANEL_CHANNEL_ID : createdId,
    user: { id: guild.ownerId, username: '功能驗證請勿處理' }, values: ['other'],
    isStringSelectMenu: () => customId === 'qcs_open', isButton: () => customId !== 'qcs_open',
    attachmentSizeLimit: 8 * 1024 * 1024,
    deferReply: async () => {}, editReply: async p => { replies.push(p.content); } });
  await system.handle(interaction('qcs_open'));
  assert(createdId && replies.at(-1).startsWith('✅'), replies.at(-1));
  await system.handle(interaction('qcs_open')); assert.equal(creates, 1);
  let channel = await client.channels.fetch(createdId);
  assert(channel.permissionOverwrites.cache.get(GUILD_ID).deny.has(P.ViewChannel));
  await channel.send({ content: '[功能驗證] 客服表單建立、關閉、完整存檔後刪除。此為測試紀錄，請勿處理。', allowedMentions: { parse: [] } });
  await system.handle(interaction(`qcs_close_${createdId}`));
  assert(replies.at(-1).startsWith('✅'), replies.at(-1));
  channel = await client.channels.fetch(createdId);
  assert.equal(parseTicket(channel.topic).state, 'closed');
  assert(channel.permissionOverwrites.cache.get(guild.ownerId).deny.has(P.ViewChannel));
  await system.handle(interaction(`qcs_archive_${createdId}`));
  assert(replies.at(-1).startsWith('✅'), replies.at(-1));
  const archive = await client.channels.fetch(ARCHIVE_CHANNEL_ID);
  const logs = await archive.messages.fetch({ limit: 10 });
  const saved = logs.find(m => m.author.id === client.user.id && m.content.includes(`[客服工單:${createdId}]`));
  assert(saved && saved.attachments.size === 1);
  await assert.rejects(client.channels.fetch(createdId, { force: true }), e => Number(e.code) === 10003);
  console.log(JSON.stringify({ result: 'passed', privateTicket: createdId, archivedMessage: saved.id,
    archiveChannel: ARCHIVE_CHANNEL_ID, deletedTestTicket: true, staffPings: 0, financialWrites: 0 }));
})().catch(error => { console.error(JSON.stringify({ error: error.message, testChannel: createdId || null })); process.exitCode = 1; })
  .finally(() => client.destroy());
