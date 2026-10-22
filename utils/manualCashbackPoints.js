const GUILD_ID = '1206138511535898654';
async function handleManualCashbackPoints(interaction, { db, isAuthorized, notify }) {
  if (interaction.guildId !== GUILD_ID || !isAuthorized(interaction)) {
    return interaction.editReply({content:'❌ 只有秋奈客服或管理員可以發送回饋點數'});
  }
  const target = interaction.options.getUser('玩家', true);
  const points = interaction.options.getNumber('點數', true);
  const reason = interaction.options.getString('備註', true).trim();
  if (target.bot || !Number.isFinite(points) || points <= 0 || points > 1000000 ||
      Math.abs(points * 100 - Math.round(points * 100)) > 1e-7 || !reason || reason.length > 200) {
    return interaction.editReply({content:'❌ 請選擇真人會員，點數須為0.01至1,000,000、最多兩位小數，並填寫200字內備註'});
  }
  // Verify current guild membership before crediting a globally keyed point account.
  try { await interaction.guild.members.fetch(target.id); }
  catch { return interaction.editReply({content:'❌ 無法確認玩家是否仍在本伺服器，未發放點數，請稍後重試'}); }
  const key = `manual-cashback:${interaction.id}`;
  const result = await db.rpc('qiunai_grant_manual_points', {
    p_operation_key:key, p_guild_id:interaction.guildId, p_user_id:target.id,
    p_actor_id:interaction.user.id, p_channel_id:interaction.channelId,
    p_points:points, p_reason:reason,
  });
  if (result.error) throw result.error;
  const grant = result.data;
  let notification = grant.already_applied ? '此請求已處理，未重複發放。' : '';
  if (!grant.already_applied) {
    try {
      await notify(target, {content:`🌧️ 小奈｜回饋點數入帳\n發放：${grant.requested_points} 點\n` +
        `沖抵退單欠點：${grant.debt_repaid} 點\n實際入帳：${grant.credited_points} 點\n` +
        `入帳後可用：${grant.balance_after} 點\n備註：${reason}\n` +
        `可到 <#1513531969315537096> 查詢最近十筆回饋明細。\n發放編號：${key}`,
        allowedMentions:{parse:[]}, nonce:interaction.id, enforceNonce:true});
      notification = '已用小奈私訊通知。';
    } catch { notification = '點數已入帳，但私訊無法送達，請提醒玩家自行查詢。'; }
  }
  return interaction.editReply({content:`✅ 回饋點數${grant.already_applied?'已處理':'已發送'}\n玩家：<@${target.id}>\n` +
    `發放：${grant.requested_points} 點｜沖抵欠點：${grant.debt_repaid} 點\n` +
    `實際入帳：${grant.credited_points} 點｜入帳後可用：${grant.balance_after} 點\n` +
    `備註：${reason}\n${notification}\n發放編號：${key}`,allowedMentions:{parse:[]}});
}
module.exports = { handleManualCashbackPoints };
