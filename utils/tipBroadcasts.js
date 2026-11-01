const TIP_BROADCAST_CHANNEL_ID = "1210250269292761099";
const LARGE_TIP_BROADCAST_CHANNEL_ID = "1544713687900880936";
const LARGE_TIP_THRESHOLD = 1300;

// Allocations already include each recipient's selected quantities and all gift items.
function selectTipBroadcastChannel(allocations = []) {
  const totalCents = allocations.reduce((total, allocation) => {
    const amount = Number(allocation.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("打賞播報金額無效");
    return total + Math.round(amount * 100);
  }, 0);
  return totalCents >= LARGE_TIP_THRESHOLD * 100
    ? LARGE_TIP_BROADCAST_CHANNEL_ID : TIP_BROADCAST_CHANNEL_ID;
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
  return allocations.flatMap((allocation) =>
    (allocation.lines || []).map((line) => ({
      staffId: allocation.staffId,
      line,
    })),
  );
}

module.exports = {
  TIP_BROADCAST_CHANNEL_ID, LARGE_TIP_BROADCAST_CHANNEL_ID, LARGE_TIP_THRESHOLD, selectTipBroadcastChannel,
  buildTipBroadcastContent,
  splitTipBroadcastAllocations,
};
