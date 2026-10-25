const { createHash } = require('node:crypto');
const { Routes } = require('discord.js');
const STAFF_GUILD_ID = '1513174069087047731';
const BUSINESS_GUILD_ID = '1206138511535898654';
function taipeiPeriod(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}
function isDispatchTime(period) { return period.hour === 23 && period.minute >= 30; }
async function acceptedStaffToday(db, date) {
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 86400000);
  const ids = new Set();
  for (let offset = 0; ; offset += 1000) {
    const result = await db.from('play_orders')
      .select('id,assigned_player,order_type,status,is_deleted')
      .eq('guild_id', BUSINESS_GUILD_ID)
      .gte('accepted_at', start.toISOString()).lt('accepted_at', end.toISOString())
      .order('id').range(offset, offset + 999);
    if (result.error || !Array.isArray(result.data)) throw Error('無法核對當日接單紀錄，停止 NAS 派送');
    for (const row of result.data) {
      if (row.is_deleted || /cancel|refund|reject|棄單|取消|退款|駁回/i.test(String(row.status || '')) || /打賞|儲值|topup|tip/i.test(String(row.order_type || ''))) continue;
      for (const id of String(row.assigned_player || '').split(',').map(value => value.trim())) {
        if (/^\d{17,20}$/.test(id)) ids.add(id);
      }
    }
    if (result.data.length < 1000) return ids;
  }
}
function readLinks(raw = process.env.QIUNAI_NAS_DAILY_UPLOAD_LINKS_JSON) {
  const rows = JSON.parse(raw || '[]');
  if (!Array.isArray(rows) || !rows.length) throw Error('缺少 UGREEN 每日收件設定；禁止回退舊 NAS');
  const seen = new Set();
  return rows.map(row => {
    const date = String(row.date || '');
    let url; try { url = new URL(row.url); } catch { throw Error('UGREEN 日期連結格式不符'); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date || seen.has(date) || url.protocol !== 'https:' || !['ug.link','www.ug.link'].includes(url.hostname) || !url.pathname.endsWith('/filemgr/collect-invite/') || !url.searchParams.get('id')) throw Error('UGREEN 日期連結重複或格式不符');
    seen.add(date);
    return { date, url: url.href };
  });
}
function planTargets(links, staff, channels, members) {
  const staffMap = new Map(staff.map(row => [String(row.discord_id), row]));
  const candidates = [], skipped = [];
  for (const link of links) {
    const row = staffMap.get(link.discord_id);
    if (!row || row.is_active === false || !members.has(link.discord_id)) { skipped.push({ id: link.discord_id, reason: '非在職或已離群' }); continue; }
    const channel = channels.get(String(row.salary_channel_id || ''));
    if (!channel || channel.type !== 0 || !channel.name.includes('填單')) { skipped.push({ id: link.discord_id, reason: '無有效填單區' }); continue; }
    const everyone = channel.permissionOverwrites.cache.get(STAFF_GUILD_ID);
    const owner = channel.permissionOverwrites.cache.get(link.discord_id);
    if (!everyone?.deny.has(1024n) || !owner?.allow.has(1024n) || owner?.deny.has(1024n)) { skipped.push({ id: link.discord_id, reason: '私人權限或本人權限不符' }); continue; }
    candidates.push({ ...link, channel });
  }
  const counts = new Map();
  for (const target of candidates) counts.set(target.channel.id, (counts.get(target.channel.id) || 0) + 1);
  const targets = candidates.filter(target => {
    if (counts.get(target.channel.id) === 1) return true;
    skipped.push({ id: target.discord_id, reason: '多人共用填單區' }); return false;
  });
  return { targets, skipped };
}
function buildNotice(target, date) {
  return {
    content: `【UGREEN 當日影片上傳｜${date}】\n<@${target.discord_id}> 請使用以下今日收件入口，上傳今天（${date}）的對局影片。\n${target.url}\n\n上傳時請填寫你的陪陪名稱，方便核對。此入口僅限上傳，請勿轉傳給店外人士。`,
    allowedMentions: { parse: [] },
    nonce: createHash('sha256').update(`ugreen:${date}:${target.discord_id}`).digest('hex').slice(0, 24), enforceNonce: true,
  };
}
async function alreadySent(channel, botId, date) {
  const marker = `【UGREEN 當日影片上傳｜${date}】`;
  const start = new Date(`${date}T00:00:00+08:00`).getTime();
  let before;
  for (let page = 0; page < 20; page++) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (messages.some(message => message.author?.id === botId && message.content?.includes(marker))) return true;
    if (messages.size < 100 || messages.last().createdTimestamp < start) return false;
    before = messages.last().id;
  }
  throw Error('尚未查完當日歷史，暫緩避免重複');
}
async function processNasNotifications(db, client, { now = new Date(), links = readLinks(), dryRun = false } = {}) {
  const period = taipeiPeriod(now);
  if (!dryRun && !isDispatchTime(period)) return { scheduled: false, date: period.date };
  const daily = links.find(link => link.date === period.date);
  if (!daily) throw Error(`UGREEN 缺少 ${period.date} 收件入口，停止發送；不使用昨日或舊 NAS 連結`);
  const result = await db.from('qiunai_staff').select('discord_id,is_active,salary_channel_id');
  if (result.error) throw Error('無法讀取 NAS 填單區對應');
  const accepted = await acceptedStaffToday(db, period.date);
  const guild = await client.guilds.fetch(STAFF_GUILD_ID);
  const channels = await guild.channels.fetch();
  const members = new Set(); let after;
  while (true) {
    const page = await client.rest.get(Routes.guildMembers(STAFF_GUILD_ID), { query: new URLSearchParams({ limit: '1000', ...(after ? { after } : {}) }) });
    for (const member of page) if (!member.user.bot) members.add(member.user.id);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  // 先以全員資料檢查是否共用頻道，再篩接單者，避免同頻道另一人沒接單而漏掉共用檢查。
  const perStaff = result.data.map(row => ({ discord_id: String(row.discord_id), url: daily.url }));
  const planned = planTargets(perStaff, result.data, channels, members);
  const targets = planned.targets.filter(target => accepted.has(target.discord_id));
  const skipped = planned.skipped.filter(row => accepted.has(row.id));
  const summary = { provider: 'UGREEN', scheduled: true, date: period.date, eligible: targets.length, skipped, sent: 0, alreadySent: 0, failures: [] };
  if (dryRun) return summary;
  for (const target of targets) {
    try {
      if (await alreadySent(target.channel, client.user.id, period.date)) { summary.alreadySent++; continue; }
      await target.channel.send(buildNotice(target, period.date)); summary.sent++;
    } catch (error) { summary.failures.push({ id: target.discord_id, channel: target.channel.id, code: String(error.code || 'DELIVERY_FAILED') }); }
  }
  return summary;
}
function startNasUploadNotificationScheduler(db, client, createNonOverlappingTask) {
  const links = readLinks();
  let completeDate = '', attemptedAt = 0;
  const run = createNonOverlappingTask('NAS 每日個人上傳連結', async () => {
    const now = new Date(), period = taipeiPeriod(now);
    if (!isDispatchTime(period) || completeDate === period.date || now.getTime() - attemptedAt < 300000) return;
    attemptedAt = now.getTime();
    const summary = await processNasNotifications(db, client, { now, links });
    if (!summary.failures.length) completeDate = period.date;
    console.log('[NAS 個人影片派送]', JSON.stringify(summary));
  });
  const timer = setInterval(run, 30000); timer.unref?.(); void run();
  const dates = links.map(link => link.date).sort();
  console.log(`[UGREEN 排程已啟用] Asia/Taipei 每日 23:30，僅通知當日接單者，日期入口 ${links.length} 筆（${dates[0]} 至 ${dates.at(-1)}）；不使用 Synology 或本機檔案`);
  return timer;
}
module.exports = { STAFF_GUILD_ID, BUSINESS_GUILD_ID, taipeiPeriod, isDispatchTime, acceptedStaffToday, readLinks, planTargets, buildNotice, alreadySent, processNasNotifications, startNasUploadNotificationScheduler };
