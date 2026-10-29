const { createHash } = require('node:crypto');
const { createGroupedCashbackNotifier } = require('./groupedCashbackNotifier');
const { createReceiptStore } = require('./receiptRecovery');
const { formatTaipeiTime } = require('./taipeiTime');
const { MEMBERSHIP_LEVELS, calculateMembershipCashback } = require('../config/qiunaiMembership20261016');
const GUILD_ID = '1206138511535898654';
const BANK_CHANNEL_ID = '1513531969315537096';

async function getCashbackEstimate(db, order) {
  if (order.guild_id !== GUILD_ID) return null;
  const saved = await db.from('qiunai_membership_cashbacks').select('points,rate,reversed_at')
    .eq('order_id', order.id).maybeSingle();
  if (saved.error) throw saved.error;
  if (saved.data) return saved.data.reversed_at ? 0 : Number(saved.data.points);
  const member = await db.from('user_vips').select('level_key,total_spent,highest_single_topup')
    .eq('guild_id', GUILD_ID).eq('user_id', order.customer_id).maybeSingle();
  if (member.error) throw member.error;
  const current = MEMBERSHIP_LEVELS.find(x => x.levelKey === member.data?.level_key);
  const eligible = MEMBERSHIP_LEVELS.filter(x => !x.invitationOnly &&
    (x.totalSpendRequired <= Number(member.data?.total_spent || 0) ||
      x.singleTopupRequired <= Number(member.data?.highest_single_topup || 0)));
  const best = [...eligible, ...(current ? [current] : [])].sort((a,b) => b.sortOrder-a.sortOrder)[0];
  return calculateMembershipCashback({ paidAmount: Math.max(0, Number(order.final_price ?? order.price ?? 0)),
    levelKey: best?.levelKey, playerCount: Math.max(1, Number(order.player_count || 1)) });
}

async function getPointSummary(db, userId) {
  const [account, logs] = await Promise.all([
    db.from('qiunai_vip_point_accounts').select('balance').eq('user_id', String(userId)).maybeSingle(),
    db.from('qiunai_vip_point_logs').select('amount,note,created_at,operation_key').eq('user_id', String(userId))
      .or('operation_key.like.membership-cashback:%,operation_key.like.membership-topup:%,operation_key.like.manual-cashback:%,operation_key.like.manual-point-deduction:%')
      .order('created_at', { ascending: false }).order('operation_key', { ascending: false }).limit(10),
  ]);
  if (account.error || logs.error) throw account.error || logs.error;
  return `💠 我的消費點數\n目前可用：${Number(account.data?.balance || 0).toLocaleString('zh-TW')} 點\n` +
    '消費點數與錢包星雨幣分開計算；可用餘額已包含折抵及退款扣回。\n\n最近十筆回饋（新到舊）：\n' +
    ((logs.data || []).map((x, i) => `${i+1}. ${formatTaipeiTime(x.created_at)}｜${x.operation_key?.startsWith('manual-point-deduction:') ? '人工扣除' : x.operation_key?.startsWith('manual-cashback:') ? '人工回饋' : x.operation_key?.startsWith('membership-topup:') ? '首充返利' : '消費回饋'}｜${Number(x.amount) > 0 ? '+' : ''}${x.amount} 點\n${String(x.note || '回饋入帳').slice(0,100)}`).join('\n\n') || '尚無回饋紀錄');
}

function completionMessage(order, award) {
  const points = Number(award.points);
  const net = Math.round((points - Number(award.debt_repaid || 0)) * 100) / 100;
  return `🌧️ 小奈｜訂單消費回饋\n訂單：${order.order_no || order.id}\n` +
    `訂單已結束，消費回饋 ${points} 點` +
    (award.debt_repaid ? `（抵扣先前退單欠點 ${award.debt_repaid} 點）` : '') +
    `，本筆實際入帳 ${net} 點。\n` +
    `可到 <#${BANK_CHANNEL_ID}> 按「我的消費點數」查詢可用餘額及異動。\n` +
    `回饋編號：${order.id}`;
}

function createCashbackNotifier(db, client, logger = console, store = createReceiptStore(db, 'qiunai:cashback-notifications')) {
  let busy = false;
  const notifyGroup = createGroupedCashbackNotifier(db, client, logger);
  async function notify(orderId, seenGroups = null) {
    // Always re-read settlement and refund state; an estimate or ATM account is not an award.
    const result = await db.from('qiunai_membership_cashbacks').select('*').eq('order_id', orderId).maybeSingle();
    if (result.error) throw result.error;
    const award = result.data;
    if (!award || award.reversed_at) return false;
    const found = await db.from('play_orders').select('id,order_no,guild_id,customer_id,paid,status,is_deleted,order_type,order_group_id')
      .eq('id',orderId).maybeSingle();
    if (found.error) throw found.error;
    const order = found.data;
    if (!order || order.guild_id !== GUILD_ID || order.customer_id !== award.user_id ||
        !order.paid || order.status !== 'completed' || order.is_deleted) return false;
    if (order.order_type === '打賞' && order.order_group_id) {
      const groupKey = JSON.stringify([order.guild_id, order.customer_id, order.order_group_id]);
      if (seenGroups?.has(groupKey)) return false;
      seenGroups?.add(groupKey);
      return notifyGroup(order);
    }
    const key = `cashback-completed:${order.id}`;
    const claim = await store.claim(key, {orderId:order.id});
    if (!claim) return false;
    try {
      const user = await client.users.fetch(order.customer_id);
      const channel = await user.createDM();
      const marker = `回饋編號：${order.id}`;
      let before, existing;
      for (let page = 0; page < 50; page++) {
        const messages = await channel.messages.fetch({limit:100, ...(before ? {before} : {})});
        existing = messages.find(m => m.author?.id === client.user.id && m.content?.endsWith(marker));
        if (existing || messages.size < 100) break;
        before = messages.last().id;
        if (page === 49) throw Error('通知歷史尚未查完，暫緩寄送避免重複');
      }
      const sent = existing || await channel.send({content:completionMessage(order,award),
        allowedMentions:{parse:[]}, nonce:createHash('sha256').update(key).digest('hex').slice(0,24), enforceNonce:true});
      await store.finish(claim, 'sent', sent.id);
      return true;
    } catch (error) {
      await store.finish(claim, Number(error.code) === 50007 ? 'dm_blocked' : 'retry', null, String(error.message).slice(0,300));
      logger.error('[消費回饋通知]', order.id, error.message);
      return false;
    }
  }
  async function run() {
    if (busy) return;
    busy = true;
    try {
      const seenGroups = new Set();
      // Scan the durable award ledger, not a timestamp watermark: late completion is not lost.
      for (let offset = 0;; offset += 100) {
        const rows = await db.from('qiunai_membership_cashbacks').select('order_id')
          .is('reversed_at',null).order('order_id').range(offset,offset+99);
        if (rows.error) throw rows.error;
        for (const row of rows.data || []) await notify(row.order_id, seenGroups);
        if ((rows.data || []).length < 100) break;
      }
    } catch (error) { logger.error('[消費回饋通知排程]', error.message); }
    finally { busy = false; }
  }
  return { notify, run, start() { const timer=setInterval(run,60000);timer.unref?.();void run();return timer; } };
}
module.exports = { GUILD_ID, BANK_CHANNEL_ID, getCashbackEstimate, getPointSummary, completionMessage, createCashbackNotifier };
