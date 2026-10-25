const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const TARGETS = new Set(['gift', 'staff', 'quantity', 'broadcast']);
function appendTipBackButton(rows, tipId, target) {
  if (!TARGETS.has(target)) throw new Error('無效的打賞返回步驟');
  const button = new ButtonBuilder().setCustomId(`tip_back_${target}_${tipId}`)
    .setLabel('上一步').setEmoji('⬅️').setStyle(ButtonStyle.Secondary);
  const last = rows.at(-1);
  if (last && last.components.length < 5 && last.components.every(c => c.data.type === 2)) last.addComponents(button);
  else rows.push(new ActionRowBuilder().addComponents(button));
  if (rows.length > 5) throw new Error('打賞選單超過 Discord 顯示限制');
  return rows;
}
function rewindTipFlow(data, target, now = Date.now()) {
  if (!TARGETS.has(target)) throw new Error('無效的打賞返回步驟');
  if (data.crownOrder) throw new Error('冠名單請使用原本的修改功能');
  if (data.checkoutStarted || data.paymentMethod || data.keepForPayment || data.paid || data.walletPaid) {
    throw new Error('此筆已進入付款流程，不能返回修改金額，請先聯繫客服取消付款單');
  }
  const next = structuredClone(data);
  const oldStamp = Number(String(data.flowId || '').split('_').at(-1)) || 0;
  next.flowId = `${data.tipperId || data.createdBy}_${Math.max(now, oldStamp + 1)}`;
  for (const key of ['broadcastEnabled','broadcastAnonymous','broadcastPreferenceCompleted',
    'broadcastPreferenceShown','staffSelectionMessageId','customPriceMessageId','requestedMethod']) delete next[key];
  if (['gift','staff','quantity'].includes(target)) {
    if (next.quantitySelectionStaffIds) next.selectedStaffIds = [...next.quantitySelectionStaffIds];
    for (const key of ['quantityCompleted','quantityMode','sharedQuantities','quantitiesByStaff',
      'allocations','amount','totalAmount']) delete next[key];
  }
  if (['gift','staff'].includes(target)) delete next.staffSelectionCompleted;
  if (target === 'gift') {
    for (const key of ['gifts','item','customPriceSet','customPriceRequired']) delete next[key];
  }
  return next;
}
module.exports = { appendTipBackButton, rewindTipFlow };
