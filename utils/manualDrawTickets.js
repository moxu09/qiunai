const GUILD_ID = '1206138511535898654';
const KINDS = { kill: '殺必死卡池抽獎券', ichiban: '秋奈一番賞抽獎券', limited: '限定卡池抽獎券' };
async function handleManualDrawTickets(interaction, { db, isAuthorized, notify }) {
  if (interaction.isPrefixCommand || interaction.guildId !== GUILD_ID || !isAuthorized(interaction)) {
    return interaction.editReply({ content: '❌ 請由秋奈客服或管理員使用 /使用抽獎券，不能使用公開文字指令。', allowedMentions: { parse: [] } });
  }
  const target = interaction.options.getUser('客人', true);
  const kind = interaction.options.getString('券種', true);
  const count = interaction.options.getInteger('張數') ?? 1;
  const reason = interaction.options.getString('備註', true).trim();
  if (target.bot || !Object.hasOwn(KINDS, kind) || !Number.isInteger(count) || count < 1 || count > 20 || !reason || reason.length > 200 || !/^\d{17,20}$/.test(interaction.id || '')) {
    return interaction.editReply({ content: '❌ 請選擇真人會員與有效券種，張數須為1至20，並填寫200字內備註。' });
  }
  try { await interaction.guild.members.fetch(target.id); }
  catch { return interaction.editReply({ content: '❌ 無法確認客人是否仍在秋奈，未核銷抽獎券，請稍後重試。' }); }
  const key = `manual-draw-ticket:${interaction.id}`;
  const result = await db.rpc('qiunai_redeem_manual_draw_tickets', {
    p_operation_key: key, p_guild_id: interaction.guildId, p_user_id: target.id,
    p_actor_id: interaction.user.id, p_channel_id: interaction.channelId,
    p_ticket_kind: kind, p_ticket_count: count, p_reason: reason,
  });
  if (result.error) {
    const insufficient = String(result.error.message || '').includes('抽獎券不足');
    return interaction.editReply({ content: insufficient ? '❌ 該券種張數不足，未扣除任何券。' : '❌ 核銷結果暫時無法確認，請保留本次操作編號，勿另開新指令重複扣券。\n操作編號：' + key });
  }
  const redemption = result.data;
  let delivery = '此操作已處理，未再次扣券。';
  if (!redemption.already_applied) {
    try {
      await notify(target, { content: `🎟️ 小奈｜抽獎券核銷通知\n${KINDS[kind]}：使用 ${count} 張\n核銷後剩餘：${redemption.remaining_count} 張\n備註：${reason}\n操作人：<@${interaction.user.id}>\n核銷編號：${key}\n本次僅核銷券，未扣錢包，也未自動抽獎。`, allowedMentions: { parse: [] }, nonce: interaction.id, enforceNonce: true });
      delivery = '已用小奈私訊通知客人。';
    } catch { delivery = '核銷成功，但客人私訊無法送達；請提醒客人查看背包。'; }
  }
  return interaction.editReply({ content: `✅ 抽獎券${redemption.already_applied ? '已處理' : '已核銷'}\n客人：<@${target.id}>\n券種：${KINDS[kind]}\n使用：${count} 張｜核銷後剩餘：${redemption.remaining_count} 張\n備註：${reason}\n${delivery}\n核銷編號：${key}\n僅核銷，不會自動抽獎或扣錢包。`, allowedMentions: { parse: [] } });
}
module.exports = { KINDS, handleManualDrawTickets };
