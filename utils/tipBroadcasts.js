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

module.exports = {
  buildTipBroadcastContent,
};
