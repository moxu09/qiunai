const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { fetchAllChannelMessages, buildDiscordArchiveHtml } = require('../utils/orderArchive');

const GUILD_ID = '1206138511535898654';
const PANEL_CHANNEL_ID = '1513803410430754888';
const ARCHIVE_CHANNEL_ID = '1562739168860307526';
const SUPPORT_ROLE_ID = '1210642900355125288';
const OPTIONS = { monthly: '申請月結', cooperation: '合作洽談', other: '其他事項' };
const PREFIX = 'qcs_';

function parseTicket(topic) {
  const match = /^qcs:v1;owner:(\d{17,20});kind:(monthly|cooperation|other);state:(open|closed)(?:;archive:(\d{17,20}))?$/.exec(topic || '');
  return match ? { owner: match[1], kind: match[2], state: match[3], archive: match[4] || null } : null;
}
function ticketTopic(ticket) {
  return `qcs:v1;owner:${ticket.owner};kind:${ticket.kind};state:${ticket.state}${ticket.archive ? `;archive:${ticket.archive}` : ''}`;
}
function panelPayload() {
  return { embeds: [new EmbedBuilder().setColor(0x8acded).setTitle('☎️ 秋奈陪玩｜客服臨時訂單')
    .setDescription('需要申請月結、合作洽談或其他協助嗎？\n請選擇需要的業務，小奈會為你建立私人客服表單並通知客服。')],
  components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('qcs_open').setPlaceholder('點擊選擇需要的業務').setMinValues(1).setMaxValues(1)
    .addOptions(Object.entries(OPTIONS).map(([value, label]) => ({ label, value }))))],
  allowedMentions: { parse: [] } };
}
function controlRows(channelId, closed) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qcs_${closed ? 'reopen' : 'close'}_${channelId}`)
      .setLabel(closed ? '重新開啟表單（客服）' : '關閉表單').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`qcs_archive_${channelId}`).setLabel('存檔並刪除（客服）')
      .setStyle(ButtonStyle.Danger))];
}

function createCustomerServiceTickets({ client, isStaff, resolveParent,
  fetchMessages = fetchAllChannelMessages, buildArchive = buildDiscordArchiveHtml }) {
  const active = new Set();
  async function withLock(key, interaction, action) {
    if (active.has(key)) return interaction.editReply({ content: '此表單正在處理，請稍候，勿重複操作。' });
    active.add(key);
    try { return await action(); } finally { active.delete(key); }
  }
  async function configuredChannel(id, permissions) {
    const channel = await client.channels.fetch(id);
    if (!channel || channel.guildId !== GUILD_ID || channel.type !== ChannelType.GuildText) {
      throw new Error('找不到秋奈客服頻道，請聯繫管理員。');
    }
    const access = channel.permissionsFor(client.user);
    if (!access || !access.has(permissions)) throw new Error('小奈缺少客服頻道的必要權限，請聯繫管理員。');
    return channel;
  }
  async function ensurePanel() {
    await configuredChannel(ARCHIVE_CHANNEL_ID, [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory]);
    const channel = await configuredChannel(PANEL_CHANNEL_ID, [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]);
    let before;
    for (;;) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = [...page.values()].find(m => m.author.id === client.user.id &&
        m.components?.some(r => r.components?.some(c => c.customId === 'qcs_open')));
      if (found) { await found.edit(panelPayload()); return { messageId: found.id, created: false }; }
      if (page.size < 100) break;
      before = page.last().id;
    }
    const message = await channel.send(panelPayload());
    return { messageId: message.id, created: true };
  }
  async function welcome(channel, ticket) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if ([...messages.values()].some(m => m.author.id === client.user.id &&
      m.embeds?.some(e => e.footer?.text === `客服表單｜${channel.id}`))) return;
    await channel.send({ content: `<@&${SUPPORT_ROLE_ID}> <@${ticket.owner}>\n🚀 客服正在手刀衝過來！請問有什麼需要協助的？`,
      embeds: [new EmbedBuilder().setColor(0x8acded).setTitle('☎️ 客服臨時訂單已建立')
        .setDescription(`服務項目：${OPTIONS[ticket.kind]}\n請直接在這裡告訴我們你的需求，客服會盡快協助你。`)
        .setFooter({ text: `客服表單｜${channel.id}` }).setTimestamp()],
      components: controlRows(channel.id, false),
      allowedMentions: { parse: [], roles: [SUPPORT_ROLE_ID], users: [ticket.owner] } });
  }
  async function open(interaction) {
    const kind = interaction.values?.[0];
    if (interaction.channelId !== PANEL_CHANNEL_ID || !Object.hasOwn(OPTIONS, kind)) {
      throw new Error('請使用客服中心最新的業務選單。');
    }
    return withLock(`owner:${interaction.user.id}`, interaction, async () => {
      await configuredChannel(ARCHIVE_CHANNEL_ID, [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory]);
      if (!await interaction.guild.roles.fetch(SUPPORT_ROLE_ID)) throw new Error("找不到客服身分組，暫時無法建立表單。");
      const channels = await interaction.guild.channels.fetch();
      const existing = [...channels.values()].find(c => {
        const t = parseTicket(c?.topic);
        return c?.guildId === GUILD_ID && t?.owner === interaction.user.id && t.state === 'open';
      });
      if (existing) {
        await welcome(existing, parseTicket(existing.topic));
        return interaction.editReply({ content: `你已有開啟中的客服表單：<#${existing.id}>，請到該頻道繼續，不必重複開單。` });
      }
      const ticket = { owner: interaction.user.id, kind, state: 'open' };
      const safeName = interaction.user.username.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').slice(0, 16) || '闆闆';
      const channel = await interaction.guild.channels.create({
        name: `${OPTIONS[kind]}-${safeName}`, type: ChannelType.GuildText,
        parent: await resolveParent(interaction.guild), topic: ticketTopic(ticket),
        permissionOverwrites: [
          { id: GUILD_ID, type: 0, deny: [P.ViewChannel] },
          { id: ticket.owner, type: 1, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
          { id: SUPPORT_ROLE_ID, type: 0, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
          { id: client.user.id, type: 1, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageChannels] },
        ], reason: `客服臨時表單：${OPTIONS[kind]}`,
      });
      try { await welcome(channel, ticket); }
      catch { return interaction.editReply({ content: `表單已建立：<#${channel.id}>，但客服通知發送失敗，請在頻道聯繫管理員，勿重複開單。` }); }
      return interaction.editReply({ content: `✅ 已建立私人客服表單：<#${channel.id}>，客服正在手刀衝過來！` });
    });
  }
  async function findArchive(archive, channelId, storedId) {
    const marker = `[客服工單:${channelId}]`;
    const valid = m => m?.author?.id === client.user.id && m.content?.includes(marker) && m.attachments?.size > 0;
    if (storedId) {
      const found = await archive.messages.fetch(storedId);
      if (!valid(found)) throw new Error('已存檔紀錄無法驗證，為保護紀錄暫不刪除表單。');
      return found;
    }
    let before;
    for (;;) {
      const page = await archive.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = [...page.values()].find(valid);
      if (found) return found;
      if (page.size < 100) return null;
      before = page.last().id;
    }
  }
  async function action(interaction, operation, channelId) {
    if (channelId !== interaction.channelId) throw new Error('請在該客服表單內操作。');
    return withLock(`channel:${channelId}`, interaction, async () => {
      const channel = await client.channels.fetch(channelId);
      const ticket = parseTicket(channel?.topic);
      if (!ticket || channel.guildId !== GUILD_ID) throw new Error('這不是小奈建立的客服臨時表單。');
      const staff = isStaff(interaction);
      if (!staff && (operation !== 'close' || interaction.user.id !== ticket.owner)) {
        throw new Error('只有客服或管理員可以存檔刪除及重新開啟；表單本人可以關閉表單。');
      }
      if (operation === 'close' || operation === 'reopen') {
        if (ticket.archive) throw new Error('此表單已存檔，請完成刪除；如需新服務請另開表單。');
        const closed = operation === 'close';
        await channel.permissionOverwrites.edit(ticket.owner, { ViewChannel: !closed, SendMessages: !closed },
          { type: 1, reason: closed ? '關閉客服表單，保留紀錄供客服處理' : '客服重新開啟表單' });
        ticket.state = closed ? 'closed' : 'open';
        await channel.setTopic(ticketTopic(ticket));
        await channel.send({ content: closed ? `🔒 <@${interaction.user.id}> 已關閉客服表單，紀錄尚未刪除。客服可存檔並刪除，或重新開啟。`
          : `🔓 客服已重新開啟表單，<@${ticket.owner}> 可以繼續留言。`,
          components: controlRows(channelId, closed), allowedMentions: { parse: [] } });
        return interaction.editReply({ content: closed ? '✅ 已關閉表單，保留紀錄等待客服存檔。' : '✅ 已重新開啟表單。' });
      }
      if (ticket.state !== 'closed') throw new Error('請先關閉表單，再存檔並刪除。');
      const archive = await configuredChannel(ARCHIVE_CHANNEL_ID, [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory]);
      let saved = await findArchive(archive, channelId, ticket.archive);
      {
        const messages = await fetchMessages(channel, 10000);
        if (messages.length >= 10000) throw new Error('訊息數超過安全存檔上限，請聯繫管理員完整匯出，表單不會刪除。');
        const html = await buildArchive({ channelName: channel.name, guildName: interaction.guild.name, messages });
        const bytes = Buffer.from(html, 'utf8');
        if (bytes.length > (interaction.attachmentSizeLimit || 8 * 1024 * 1024)) {
          throw new Error('紀錄檔超過 Discord 上傳限制，表單不會刪除，請聯繫管理員。');
        }
        const payload = { content: `[客服工單:${channelId}] 📁 ${channel.name}\n申請人：<@${ticket.owner}>｜項目：${OPTIONS[ticket.kind]}\n存檔人：<@${interaction.user.id}>`,
          files: [new AttachmentBuilder(bytes, {
            name: `${ticket.kind}-${channelId}.html`,
            title: `${OPTIONS[ticket.kind]}-${channelId}`,
          })],
          allowedMentions: { parse: [] } };
        saved = saved ? await saved.edit({ ...payload, attachments: [] }) : await archive.send(payload);
        if (!saved.attachments?.size) throw new Error('未確認存檔附件成功上傳，表單不會刪除。');
        ticket.archive = saved.id;
        await channel.setTopic(ticketTopic(ticket));
        const latest = await channel.messages.fetch({ limit: 1 });
        if ((latest.first()?.id || null) !== (messages.at(-1)?.id || null)) {
          throw new Error("存檔期間有新訊息，已保留表單，請再次點選存檔並刪除以更新紀錄。");
        }
      }
      await interaction.editReply({ content: `✅ 已存檔至 <#${ARCHIVE_CHANNEL_ID}>，正在刪除客服表單。` });
      await channel.delete(`客服表單存檔完成｜${saved.id}`);
    });
  }
  async function handle(interaction) {
    if (!interaction.customId?.startsWith(PREFIX)) return false;
    await interaction.deferReply({ flags: 64 });
    try {
      if (interaction.guildId !== GUILD_ID) throw new Error('此客服表單僅供秋奈伺服器使用。');
      if (interaction.customId === 'qcs_open' && interaction.isStringSelectMenu()) await open(interaction);
      else {
        const match = /^qcs_(close|reopen|archive)_(\d{17,20})$/.exec(interaction.customId);
        if (!match || !interaction.isButton()) throw new Error('表單操作已失效，請使用最新訊息。');
        await action(interaction, match[1], match[2]);
      }
    } catch (error) {
      console.error('[客服臨時表單]', error.message);
      await interaction.editReply({ content: `❌ ${error.message}\n若存檔或刪除未完成，原表單會保留，請聯繫客服。` });
    }
    return true;
  }
  return { ensurePanel, handle };
}
module.exports = { createCustomerServiceTickets, parseTicket, ticketTopic, panelPayload,
  GUILD_ID, PANEL_CHANNEL_ID, ARCHIVE_CHANNEL_ID, SUPPORT_ROLE_ID };
