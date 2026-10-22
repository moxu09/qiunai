const { createHash } = require('node:crypto');
const { MEMBERSHIP_LEVELS } = require('../config/qiunaiMembership20261016');
const GUILD_ID = '1206138511535898654';
const TABLE = 'qiunai_vip_rebate_notifications';

function taipeiPeriod(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600000);
  return { month: local.toISOString().slice(0, 7) + '-01', day: local.getUTCDate() };
}
function rebateEligibility(levelKey) {
  const rank = MEMBERSHIP_LEVELS.find(x => x.levelKey === levelKey)?.sortOrder || 0;
  return { eligible: rank >= 7, weekly: rank >= 9, monthlyRate: rank >= 9 ? 3 : 2 };
}
function buildRebateReminder(userId, month, levelKey) {
  const rule = rebateEligibility(levelKey);
  if (!rule.eligible) throw new Error('會員尚未符合首充返利資格');
  const button = (plan, label) => ({ type: 2, style: 1, label,
    custom_id: `qrebate:${month}:${userId}:${plan}` });
  return {
    content: `🌧️ 小奈提醒：${month.slice(0,7)} 首充返利方案\n` +
      `每月首充回饋 ${rule.monthlyRate}% 消費點數` + (rule.weekly ? '，或選每週首充回饋 1% 消費點數。' : '。') +
      '\n請在首次購幣前選擇；未選預設月方案。本月一旦使用返利就不能改方案，次月可重新選擇。週期依台灣時間週一計算，點數不是錢包星雨幣。',
    components: [{ type: 1, components: [button('monthly', `每月首充 ${rule.monthlyRate}%`),
      ...(rule.weekly ? [button('weekly', '每週首充 1%')] : [])] }],
    nonce: createHash('sha256').update(`qrebate:${month}:${userId}`).digest('hex').slice(0,24),
    enforceNonce: true, allowedMentions: { parse: [] },
  };
}
function parseChoice(customId, userId, now = new Date()) {
  const match = /^qrebate:(\d{4}-\d{2}-01):(\d+):(monthly|weekly)$/.exec(customId);
  if (!match || match[2] !== userId) throw new Error('只有收到這則私訊的會員可以選擇');
  if (match[1] !== taipeiPeriod(now).month) throw new Error('這則首充方案訊息已過期，請使用本月訊息或 /首充返利');
  return { month: match[1], plan: match[3] };
}
async function handleRebateChoice(interaction, supabase) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
  try {
    const choice = parseChoice(interaction.customId, interaction.user.id);
    const { error } = await supabase.rpc('qiunai_choose_membership_rebate_month', {
      p_user_id: interaction.user.id, p_billing_month: choice.month, p_plan: choice.plan,
    });
    if (error) throw error;
    await interaction.editReply({ content: `✅ 本月已選擇${choice.plan === 'weekly' ? '每週' : '每月'}首充返利，回饋為消費點數。首次使用返利前仍可重新選擇，使用後本月鎖定。` });
  } catch (error) {
    await interaction.editReply({ content: `❌ ${String(error.message || '方案設定失敗，請稍後重試').slice(0,300)}` });
  }
}
async function processVipRebateNotifications(supabase, client, now = new Date()) {
  const period = taipeiPeriod(now);
  if (period.day !== 1) return { scheduled: false, sent: 0 };
  const { data: users, error } = await supabase.from('user_vips').select('user_id,level_key').eq('guild_id', GUILD_ID);
  if (error) throw error;
  const eligible = users.filter(u => rebateEligibility(u.level_key).eligible);
  if (!eligible.length) return { scheduled: true, sent: 0 };
  const queued = await supabase.from(TABLE).upsert(eligible.map(u => ({ user_id: u.user_id, billing_month: period.month })),
    { onConflict: 'billing_month,user_id', ignoreDuplicates: true });
  if (queued.error) throw queued.error;
  const pending = await supabase.from(TABLE).select('*').eq('billing_month',period.month)
    .in('status',['pending','sending','failed']).lt('attempt_count', 5);
  if (pending.error) throw pending.error;
  let sent = 0;
  for (const row of pending.data || []) {
    if (row.attempted_at && now - new Date(row.attempted_at) < 5 * 60000) continue;
    const user = eligible.find(u => u.user_id === row.user_id);
    if (!user) continue;
    const stamp = new Date().toISOString();
    let claim = supabase.from(TABLE).update({ status: 'sending', attempted_at: stamp, attempt_count: row.attempt_count + 1 })
      .eq('billing_month',period.month).eq('user_id',row.user_id).eq('status',row.status);
    claim = row.attempted_at ? claim.eq('attempted_at',row.attempted_at) : claim.is('attempted_at',null);
    const claimed = await claim.select('user_id').maybeSingle();
    if (claimed.error) throw claimed.error;
    if (!claimed.data) continue;
    const save = async values => {
      const result = await supabase.from(TABLE).update(values).eq('billing_month',period.month)
        .eq('user_id',row.user_id).eq('attempted_at',stamp);
      if (result.error) throw result.error;
    };
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.members.fetch(row.user_id);
      const recipient = await client.users.fetch(row.user_id);
      const channel = await recipient.createDM();
      const payload = buildRebateReminder(row.user_id,period.month,user.level_key);
      // 在 Discord 成功、資料庫尚未標記時重啟：先依固定內容找回已寄出的訊息。
      const recent = row.attempt_count > 0 ? await channel.messages.fetch({ limit:100 }) : null;
      const existing = recent?.find(m => m.author?.id === client.user.id && m.content === payload.content);
      const message = existing || await channel.send(payload);
      await save({ status:'sent',dm_channel_id:channel.id,dm_message_id:message.id,sent_at:message.createdAt.toISOString(),last_error:null });
      sent++;
    } catch (err) {
      const status = Number(err.code) === 10007 ? 'left' : [50007,10013].includes(Number(err.code)) ? 'blocked' : 'failed';
      await save({ status,last_error:String(err.message || err).slice(0,300) });
    }
  }
  return { scheduled:true,sent };
}
function startVipRebateNotificationScheduler(supabase,client,createNonOverlappingTask) {
  const run = createNonOverlappingTask('VIP 每月首充方案私訊', () => processVipRebateNotifications(supabase,client));
  const timer = setInterval(run, 60000); timer.unref?.(); void run(); return timer;
}
module.exports = { GUILD_ID,taipeiPeriod,rebateEligibility,buildRebateReminder,parseChoice,
  handleRebateChoice,processVipRebateNotifications,startVipRebateNotificationScheduler };
