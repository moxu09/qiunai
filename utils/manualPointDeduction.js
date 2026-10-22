const GUILD_ID = '1206138511535898654';

async function handleManualPointDeduction(interaction, { db, isAuthorized, notify }) {
  const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
  if (interaction.isPrefixCommand) return reply('請使用 /扣除消費點數，以私密方式操作。');
  if (interaction.guildId !== GUILD_ID || !isAuthorized(interaction)) {
    return reply('❌ 只有秋奈客服或管理員可以扣除消費點數');
  }
  const target = interaction.options.getUser('玩家', true);
  const points = interaction.options.getNumber('點數', true);
  const reason = (interaction.options.getString('備註', true) || '').trim();
  if (target.bot || !Number.isFinite(points) || points <= 0 || points > 1000000 ||
      Math.abs(points * 100 - Math.round(points * 100)) > 1e-7 || !reason || reason.length > 200) {
    return reply('❌ 請選擇真人會員，點數須為0.01至1,000,000、最多兩位小數，並填寫200字內備註');
  }
  try { await interaction.guild.members.fetch(target.id); }
  catch { return reply('❌ 無法確認玩家是否仍在本伺服器，未扣除點數，請稍後重試'); }
  const key = `manual-point-deduction:${interaction.id}`;
  let result;
  try {
    result = await db.rpc('qiunai_deduct_manual_points', {
      p_operation_key: key, p_guild_id: interaction.guildId, p_user_id: target.id,
      p_actor_id: interaction.user.id, p_channel_id: interaction.channelId,
      p_points: points, p_reason: reason,
    });
    if (result.error || !result.data) throw result.error || new Error('Empty deduction result');
  } catch (error) {
    console.error('[人工扣除消費點數]', error.message);
    return reply(`❌ 未能確認扣除結果，請勿另開指令重複扣除；請先查詢點數明細並提供操作編號給管理員。\n操作編號：${key}`);
  }
  const deduction = result.data;
  if (deduction.applied === false && deduction.reason === 'insufficient_points') {
    return reply(`❌ 可用點數不足，未扣除。\n玩家：<@${target.id}>\n欲扣除：${points} 點｜目前可用：${deduction.available_points} 點`);
  }
  if (deduction.applied !== true) {
    return reply(`❌ 扣除結果異常，請先查詢明細，勿重複扣除。\n操作編號：${key}`);
  }
  let notification = '此請求已處理，未重複扣除。';
  if (!deduction.already_applied) {
    try {
      await notify(target, {
        content: `🌧️ 小奈｜消費點數扣除通知\n扣除：${deduction.requested_points} 點\n` +
          `扣除後可用：${deduction.balance_after} 點\n備註：${reason}\n` +
          `可到 <#1513531969315537096> 查詢最近十筆回饋明細。\n操作編號：${key}`,
        allowedMentions: { parse: [] }, nonce: interaction.id, enforceNonce: true,
      });
      notification = '已用小奈私訊通知。';
    } catch { notification = '點數已扣除，但私訊無法送達，請提醒玩家自行查詢。'; }
  }
  return reply(`✅ 消費點數${deduction.already_applied ? '已處理' : '已扣除'}\n玩家：<@${target.id}>\n` +
    `扣除：${deduction.requested_points} 點｜扣除前：${deduction.balance_before} 點｜扣除後可用：${deduction.balance_after} 點\n` +
    `備註：${reason}\n${notification}\n操作編號：${key}`);
}

module.exports = { handleManualPointDeduction };
