const { createHash } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const CHANNEL_ID = '1513321718784196718';
const PAGE_URL = 'https://qiunai.gaming.wearestilllhere.com/ichiban';
const PREFIX = 'qiunai_ichiban_';
const TIER_COLORS = { S: 0xffd166, A: 0xf0adcf, B: 0x9cc9fa, C: 0xaedbd2, D: 0xd8c5f3, E: 0xc2d5ec, F: 0xa6b6c8 };

function requestIdForInteraction(interactionId) {
  const hex = createHash('sha256').update(`qiunai-ichiban:${interactionId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function formatStock(prizes, stock) {
  const counts = new Map((stock || []).map((row) => [row.prize_id, Number(row.remaining || 0)]));
  return (prizes || []).map((prize) => `${prize.tier}｜${prize.name}：${counts.get(prize.id) || 0}`).join('\n');
}

function buildPanel({ prizes, stock, enabled }) {
  const remaining = (stock || []).reduce((sum, row) => sum + Number(row.remaining || 0), 0);
  const embed = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('✦ 秋奈一番賞｜星雨幸運籤')
    .setDescription(`每抽 **300 ASD**｜共 500 張，剩餘 **${remaining} 張**\n最後一抽獲得全集賞 AirPods Pro。\n\n${formatStock(prizes, stock)}\n\n[網頁版獎品圖與互動預覽](${PAGE_URL})`)
    .setImage('https://qiunai.gaming.wearestilllhere.com/ichiban/prizes.png')
    .setFooter({ text: enabled ? '抽取後先顯示抽紙，再按揭曉；ASD 扣款只會執行一次。' : '正式抽獎尚未開放' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}draw`).setLabel('🎟️ 抽一張・300 ASD').setStyle(ButtonStyle.Primary).setDisabled(!enabled || remaining === 0),
    new ButtonBuilder().setCustomId(`${PREFIX}stock`).setLabel('📦 查看剩餘獎品').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}mine`).setLabel('🧾 我的最近一抽').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('🌐 查看網頁版').setStyle(ButtonStyle.Link).setURL(PAGE_URL),
  );
  return { embeds: [embed], components: [row] };
}

function createIchiban({ supabase, client, getPanelMessage, savePanelMessage, enabled = false }) {
  async function loadStock() {
    const [{ data: prizes, error: prizeError }, { data: stock, error: stockError }] = await Promise.all([
      supabase.from('qiunai_ichiban_prizes').select('id,tier,name').order('tier').order('id'),
      supabase.rpc('qiunai_ichiban_stock'),
    ]);
    if (prizeError || stockError) throw prizeError || stockError;
    return { prizes, stock };
  }

  async function publishPanel() {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error('一番賞頻道無法發訊息');
    const payload = buildPanel({ ...(await loadStock()), enabled });
    const existing = await getPanelMessage('ichiban');
    if (existing?.message_id) {
      const message = await channel.messages.fetch(existing.message_id).catch(() => null);
      if (message) { await message.edit(payload); return message; }
    }
    const message = await channel.send(payload);
    await savePanelMessage('ichiban', channel.id, message.id);
    return message;
  }

  async function handle(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith(PREFIX)) return false;
    const action = interaction.customId.slice(PREFIX.length);
    if (action === 'stock') {
      const payload = buildPanel({ ...(await loadStock()), enabled });
      await interaction.reply({ embeds: payload.embeds, flags: 64 });
      return true;
    }
    if (action === 'mine') {
      const { data: draw, error } = await supabase.from('qiunai_ichiban_draws')
        .select('id,prize_id,ticket_no,is_last_one,created_at').eq('discord_user_id', interaction.user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!draw) { await interaction.reply({ content: '目前沒有一番賞抽取紀錄。', flags: 64 }); return true; }
      const { data: prize, error: prizeError } = await supabase.from('qiunai_ichiban_prizes')
        .select('tier,name').eq('id', draw.prize_id).single();
      if (prizeError) throw prizeError;
      await interaction.reply({ content: `🧾 我的最近一抽｜抽紙 #${draw.ticket_no}\n${prize.tier} 賞｜${prize.name}${draw.is_last_one ? '\n🏆 全集賞｜AirPods Pro' : ''}\n紀錄：${draw.id}`, flags: 64 });
      return true;
    }
    if (action === 'draw') {
      if (!enabled) { await interaction.reply({ content: '一番賞正式抽獎尚未開放，未扣除 ASD。', flags: 64 }); return true; }
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`${PREFIX}confirm_${interaction.user.id}_${requestIdForInteraction(interaction.id)}`).setLabel('確認扣除 300 ASD 並抽取').setStyle(ButtonStyle.Danger));
      await interaction.reply({ content: '每抽 300 ASD，按下確認後才會扣款並鎖定抽紙。抽取後無法取消。', components: [row], flags: 64 });
      return true;
    }
    if (action.startsWith('confirm_')) {
      const [ownerId, requestId] = action.slice('confirm_'.length).split('_');
      if (ownerId !== interaction.user.id || !/^[0-9a-f-]{36}$/.test(requestId || '')) {
        await interaction.reply({ content: '這不是你的抽獎確認按鈕。', flags: 64 }); return true;
      }
      if (!enabled) { await interaction.reply({ content: '一番賞正式抽獎尚未開放，未扣除 ASD。', flags: 64 }); return true; }
      await interaction.deferUpdate();
      const { data, error } = await supabase.rpc('qiunai_ichiban_draw_asd', {
        p_discord_user_id: interaction.user.id,
        p_request_id: requestId,
      });
      if (error) {
        await interaction.editReply({ content: `抽獎未完成，未扣除 ASD：${error.message}`, components: [] });
        return true;
      }
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`${PREFIX}reveal_${data.draw_id}`).setLabel('🪄 往右掀開抽紙').setStyle(ButtonStyle.Success));
      await interaction.editReply({ content: `🎟️ 秋奈一番賞｜抽紙 #${data.ticket_no}\n\n┏━━━━━━━━━━━━━━━┓\n┃　✨ 抓住紙角往右掀開　→　┃\n┗━━━━━━━━━━━━━━━┛\n\n已扣 300 ASD；按下方按鈕揭曉。`, components: [row] });
      void publishPanel().catch((panelError) => console.error('[一番賞] 更新獎池面板失敗', panelError));
      return true;
    }
    if (action.startsWith('reveal_')) {
      const drawId = action.slice('reveal_'.length);
      if (!/^[0-9a-f-]{36}$/.test(drawId)) { await interaction.reply({ content: '抽紙編號無效。', flags: 64 }); return true; }
      await interaction.deferUpdate();
      const { data: draw, error } = await supabase.from('qiunai_ichiban_draws')
        .select('id,discord_user_id,prize_id,ticket_no,is_last_one').eq('id', drawId).single();
      if (error || !draw || draw.discord_user_id !== interaction.user.id) {
        await interaction.followUp({ content: '只有這張抽紙的持有人可以揭曉。', flags: 64 }); return true;
      }
      const { data: prize, error: prizeError } = await supabase.from('qiunai_ichiban_prizes')
        .select('tier,name').eq('id', draw.prize_id).single();
      if (prizeError || !prize) { await interaction.followUp({ content: '暫時無法取得獎品，請聯繫客服並提供抽紙編號。', flags: 64 }); return true; }
      const grand = prize.tier === 'S' || draw.is_last_one;
      await interaction.editReply({ content: '🎟️ 秋奈一番賞｜抽紙往右掀開中…　▰▱▱▱', components: [] });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await interaction.editReply({ content: '🎟️ 秋奈一番賞｜抽紙往右掀開中…　▰▰▰▱', components: [] });
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (grand) {
        await interaction.editReply({ content: '✨　✦　✨　✦　✨\n🎉 金色星雨正在綻放…\n✨　✦　✨　✦　✨', components: [] });
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      const embed = new EmbedBuilder().setColor(TIER_COLORS[prize.tier] || 0xd4af37)
        .setTitle(grand ? '🎉 ✨ 恭喜抽中大獎！ ✨ 🎉' : `🎁 恭喜抽中 ${prize.tier} 賞！`)
        .setDescription(`抽紙 #${draw.ticket_no}\n**${prize.tier} 賞｜${prize.name}**${draw.is_last_one ? '\n\n🏆 **全集賞｜AirPods Pro**（最後一抽）' : ''}`)
        .setImage(grand ? 'https://qiunai.gaming.wearestilllhere.com/ichiban/prizes.png' : 'https://qiunai.gaming.wearestilllhere.com/ichiban/ticket.png')
        .setFooter({ text: `抽獎紀錄 ${draw.id}｜實際獎品以本紀錄為準` });
      await interaction.editReply({ content: grand ? '✨✨✨ 星雨綻放・全場恭喜！ ✨✨✨' : '', embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}draw`).setLabel('🎟️ 再抽一張・300 ASD').setStyle(ButtonStyle.Primary))] });
      return true;
    }
    return false;
  }
  return { publishPanel, handle, loadStock };
}

module.exports = { CHANNEL_ID, buildPanel, createIchiban, requestIdForInteraction };
