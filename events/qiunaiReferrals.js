const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle } = require('discord.js');
const GUILD_ID = '1206138511535898654';
const CHANNEL_ID = '1562752979998605362';
function referralPanel() {
  return { embeds: [new EmbedBuilder().setColor(0x8acded).setTitle('🎟️ 秋奈｜專屬邀請碼')
    .setDescription('邀請朋友一起來玩！\n\n點「生成邀請碼」取得你的專屬代碼，再請朋友按「輸入邀請碼」。\n'
      + '輸入時限尚未消費、或只消費過一單的人；一般訂單與打賞皆算，儲值不算。\n'
      + '第一筆消費實付滿 500 元（扣除優惠券、點數折抵後）即可獲獎；可先輸入代碼再付款，或首單付款後再輸入。\n'
      + '同一筆打賞送給多位陪陪仍算一單。首單未滿 500 元，不以第二單累計。\n\n'
      + '🎁 邀請人：9 折優惠券 ×1\n🎁 被邀請人：9 折優惠券 ×2\n'
      + '每人只能領取一次被邀請獎勵、不能邀請自己；邀請人每成功邀請一位不同新客可再得一張。\n'
      + '9 折券沿用現有規則：限原價 800 元內陪玩訂單，每筆限一張，不與限時活動併用。\n獎勵會自動放入背包。')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('qref_generate').setLabel('生成邀請碼').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('qref_enter').setLabel('輸入邀請碼').setStyle(ButtonStyle.Success))],
    allowedMentions: { parse: [] } };
}
function resultText(result) {
  if (result.status === 'rewarded') return result.already_granted
    ? '✅ 你已領取過邀請獎勵，這次沒有重複發券。'
    : '🎉 條件符合！邀請人已獲得 1 張、你已獲得 2 張 9 折優惠券，請到背包查看。';
  if (result.status === 'ineligible') return `❌ ${result.reason || '不符合邀請碼獎勵資格。'}`;
  if (result.status !== 'pending') throw new Error('邀請資格結果不正確，請聯繫客服。');
  return Number(result.purchase_count) > 0 || Number(result.paid_amount) > 0
    ? `✅ 邀請碼已綁定。首單目前實付 ${result.paid_amount} 元，未達 500 元，尚不發券；不能用第二筆消費補足。`
    : '✅ 邀請碼已綁定。第一筆一般訂單或打賞實付滿 500 元並付款成功後，系統會自動核對並發券。';
}
function createQiunaiReferrals({ db, client, logger = console, intervalMs = 30000 }) {
  let timer, busy = false;
  async function ensurePanel() {
    const ready = await db.from('qiunai_referral_codes').select('user_id').limit(0);
    if (ready.error) throw ready.error;
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || channel.guildId !== GUILD_ID) throw new Error('找不到秋奈邀請碼專區');
    let before;
    for (;;) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = [...messages.values()].find(m => m.author.id === client.user.id &&
        m.components?.some(r => r.components?.some(b => b.customId === 'qref_generate')));
      if (found) { await found.edit(referralPanel()); return found.id; }
      if (messages.size < 100) break;
      before = messages.last().id;
    }
    return (await channel.send(referralPanel())).id;
  }
  async function reconcile() {
    if (busy) return;
    busy = true;
    try {
      const result = await db.rpc('qiunai_referral_process_pending', { p_limit: 100 });
      if (result.error) throw result.error;
      return result.data;
    } finally { busy = false; }
  }
  async function start() {
    if (timer) return;
    await reconcile();
    timer = setInterval(() => reconcile().catch(error => logger.error('[邀請獎勵核對失敗]', error.message)), intervalMs);
    timer.unref?.();
  }
  async function handle(interaction) {
    if (!interaction.customId?.startsWith('qref_')) return false;
    if (interaction.guildId !== GUILD_ID || interaction.channelId !== CHANNEL_ID || interaction.user.bot) {
      await interaction.reply({ content: '請在秋奈邀請碼專區使用此功能。', flags: 64 }); return true;
    }
    if (interaction.customId === 'qref_enter' && interaction.isButton()) {
      const field = new TextInputBuilder().setCustomId('code').setLabel('朋友的專屬邀請碼')
        .setStyle(TextInputStyle.Short).setMinLength(18).setMaxLength(18).setRequired(true);
      await interaction.showModal(new ModalBuilder().setCustomId('qref_submit').setTitle('輸入邀請碼')
        .addComponents(new ActionRowBuilder().addComponents(field)));
      return true;
    }
    await interaction.deferReply({ flags: 64 });
    try {
      if (interaction.customId === 'qref_generate' && interaction.isButton()) {
        const { data, error } = await db.rpc('qiunai_referral_get_code', { p_user_id: interaction.user.id });
        if (error) throw error;
        if (!/^QN[A-F0-9]{16}$/.test(data || '')) throw new Error('邀請碼資料不正確，請稍後再試');
        await interaction.editReply({ content: `你的專屬邀請碼：\n\`${data}\`\n\n代碼會一直保留；每成功邀請一位符合資格的新客，你就能獲得一張 9 折券。`, allowedMentions: { parse: [] } });
      } else if (interaction.customId === 'qref_submit' && interaction.isModalSubmit()) {
        const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
        if (!/^QN[A-F0-9]{16}$/.test(code)) throw new Error('邀請碼格式不正確，請完整貼上朋友的邀請碼');
        const { data, error } = await db.rpc('qiunai_referral_bind', { p_invitee_id: interaction.user.id, p_code: code });
        if (error) throw error;
        await interaction.editReply({ content: resultText(data), allowedMentions: { parse: [] } });
      } else throw new Error('此按鈕或表單已失效，請使用最新的邀請碼面板');
    } catch (error) {
      logger.error('[邀請碼]', error.message);
      await interaction.editReply({ content: `❌ ${error.message || '系統暫時無法確認資格，請稍後再試。'}`, allowedMentions: { parse: [] } });
    }
    return true;
  }
  return { ensurePanel, handle, start, reconcile, stop() { clearInterval(timer); timer = null; } };
}
module.exports = { createQiunaiReferrals, referralPanel, resultText, GUILD_ID, CHANNEL_ID };
