const { EmbedBuilder } = require("discord.js");

function buildConfirmedTipEmbed(oldEmbed, actorId) {
  // Keep the original recipients/details once; an Embed field is limited to 1024 characters.
  const embed = EmbedBuilder.from(oldEmbed).setColor("#57F287").setTitle("✅ 打賞已付款");
  embed.setFields((oldEmbed.fields || []).filter(field =>
    !["扣款狀態", "打賞狀態", "付款狀態"].includes(field.name)));
  embed.addFields({ name: "付款狀態", value: `✅ 已由 <@${actorId}> 確認付款`, inline: false });
  embed.toJSON();
  return embed;
}

function recoverManualTip(message, flowId, botId, gifts, history = []) {
  if (message.author?.id !== botId || message.embeds?.[0]?.title !== "💝 打賞需求") return null;
  const fields = message.embeds[0].fields || [];
  const field = name => fields.find(item => item.name === name)?.value || "";
  const tipperId = field("打賞人").match(/^<@(\d+)>$/)?.[1];
  if (!tipperId || !flowId.startsWith(`${tipperId}_`)) return null;
  const staffIds = [...field("受賞陪陪").matchAll(/<@(\d+)>/g)].map(match => match[1]);
  const total = Number(field("總金額").replace(/^NT\$/, "").replaceAll(",", ""));
  const allocations = [];
  for (const row of field("打賞明細").split("\n")) {
    const match = row.match(/^<@(\d+)>：(.+)｜([\d,]+) ASD$/);
    if (!match) return null;
    const lines = [];
    for (const text of match[2].split("、")) {
      const part = text.match(/^(.+)×(\d+)$/);
      const gift = part && gifts.find(item => item.name === part[1]);
      if (!gift || gift.customPrice || !Number.isSafeInteger(gift.price) || gift.price <= 0) return null;
      const quantity = Number(part[2]);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 999) return null;
      lines.push({ ...gift, quantity, subtotal: gift.price * quantity });
    }
    const amount = lines.reduce((sum, line) => sum + line.subtotal, 0);
    if (amount !== Number(match[3].replaceAll(",", ""))) return null;
    allocations.push({ staffId: match[1], item: match[2], amount, lines });
  }
  if (!staffIds.length || new Set(staffIds).size !== staffIds.length ||
      allocations.length !== staffIds.length || new Set(allocations.map(x => x.staffId)).size !== staffIds.length ||
      allocations.some(x => !staffIds.includes(x.staffId) || x.staffId === tipperId) ||
      allocations.reduce((sum, x) => sum + x.amount, 0) !== total || total <= 0) return null;
  const start = Number(flowId.split("_").at(-1));
  const relevant = history.filter(m => m.author?.id === botId && m.createdTimestamp >= start &&
    m.createdTimestamp < message.createdTimestamp).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const broadcast = relevant.find(m => /已選擇需要公開播報|已選擇不.*播報/.test(m.content));
  const privacy = relevant.find(m => /付款完成後會以/.test(m.content));
  return { flowId, tipperId, channelId: message.channelId, guildId: message.guildId,
    selectedStaffIds: staffIds, allocations, paymentMethod: field("付款方式"),
    broadcastEnabled: Boolean(broadcast?.content.includes("已選擇需要公開播報")),
    broadcastAnonymous: Boolean(privacy?.content.includes("匿名")) };
}

module.exports = { buildConfirmedTipEmbed, recoverManualTip };
