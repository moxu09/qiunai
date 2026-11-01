const TIP_BROADCAST_CHANNEL_ID = "1210250269292761099";
const LARGE_TIP_BROADCAST_CHANNEL_ID = "1544713687900880936";
const LARGE_TIP_THRESHOLD = 1300;

// Each recipient's gifts in this checkout are combined; different recipients never share the threshold.
function selectTipBroadcastChannel(amount = 0) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) {
    throw new Error("打賞播報金額無效");
  }
  return Math.round(value * 100) >= LARGE_TIP_THRESHOLD * 100
    ? LARGE_TIP_BROADCAST_CHANNEL_ID : TIP_BROADCAST_CHANNEL_ID;
}

function getTipBroadcastChannels(allocations = []) {
  const centsByStaff = new Map();
  for (const allocation of allocations) {
    const staffId = String(allocation.staffId || "").trim();
    if (!staffId) throw new Error("打賞播報缺少受賞陪陪");
    selectTipBroadcastChannel(allocation.amount);
    const total = (centsByStaff.get(staffId) || 0) + Math.round(Number(allocation.amount) * 100);
    if (!Number.isSafeInteger(total)) throw new Error("打賞播報金額無效");
    centsByStaff.set(staffId, total);
  }
  return new Map([...centsByStaff].map(([staffId, cents]) => [staffId, selectTipBroadcastChannel(cents / 100)]));
}

function buildTipBroadcastContent({
  anonymous,
  description,
  emoji,
  giftName,
  staffIds,
  tipperId,
}) {
  const sender = anonymous ? "匿名闆闆" : `<@${tipperId}>`;
  const recipients = staffIds.map((id) => `<@${id}>`).join(" ");
  const giftLine = `${giftName}${emoji ? ` ${emoji}` : ""}`;

  return (
    `**感謝 ${sender} 送給 ${recipients}\n\n` +
    `${giftLine}\n\n` +
    `${description}**`
  );
}

function splitTipBroadcastAllocations(allocations = []) {
  const channels = getTipBroadcastChannels(allocations);
  return allocations.flatMap((allocation) =>
    (allocation.lines || []).map((line) => ({
      staffId: allocation.staffId,
      channelId: channels.get(String(allocation.staffId).trim()),
      line,
    })),
  );
}

module.exports = {
  TIP_BROADCAST_CHANNEL_ID, LARGE_TIP_BROADCAST_CHANNEL_ID, LARGE_TIP_THRESHOLD, selectTipBroadcastChannel, getTipBroadcastChannels,
  buildTipBroadcastContent,
  splitTipBroadcastAllocations,
};
