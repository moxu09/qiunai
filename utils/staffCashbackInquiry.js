const { getPointSummary } = require('./membershipCashback');
const GUILD_ID = '1206138511535898654';

async function handleStaffCashbackInquiry(interaction, { db, isAuthorized, readSummary = getPointSummary }) {
  // Prefix replies are public; financial inquiries must stay in an ephemeral slash reply.
  if (interaction.isPrefixCommand) {
    return interaction.editReply({content:'請使用 /查看回饋點數，以私密方式查詢。',allowedMentions:{parse:[]}});
  }
  if (interaction.guildId !== GUILD_ID || !isAuthorized(interaction)) {
    return interaction.editReply({content:'❌ 只有秋奈客服或管理員可以查看其他會員的回饋點數'});
  }
  const target = interaction.options.getUser('玩家', true);
  if (target.bot) return interaction.editReply({content:'❌ 請選擇真人會員，不能查詢機器人帳號'});
  try { await interaction.guild.members.fetch(target.id); }
  catch { return interaction.editReply({content:'❌ 無法確認玩家是否仍在本伺服器，請稍後重試'}); }
  try {
    const summary = await readSummary(db, target.id);
    return interaction.editReply({
      embeds:[{title:'秋奈｜回饋點數查詢',color:0x00ffff,
        description:`會員：<@${target.id}>（${target.id}）\n\n${summary.replace('💠 我的消費點數','💠 消費回饋點數')}`,
        footer:{text:'僅查詢，不會發放或扣除點數；時間為台北時間'}}],
      allowedMentions:{parse:[]},
    });
  } catch (error) {
    console.error('[客服回饋點數查詢]', error.message);
    return interaction.editReply({content:'❌ 回饋點數暫時無法讀取，請稍後重試；這不代表會員點數為零。'});
  }
}
module.exports = { handleStaffCashbackInquiry };
