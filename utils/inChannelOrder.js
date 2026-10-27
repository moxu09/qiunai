const MARKER = "[IN_CHANNEL_ORDER]";

function isInChannelOrder(order) {
  return String(order?.note || "").includes(MARKER);
}

function selectedPlayerIds(order) {
  return [...new Set(String(order?.preferred_player || "").split(",").map(id => id.trim()).filter(Boolean))];
}

function assertInChannelSelection(order, channelId = order?.channel_id) {
  if (!isInChannelOrder(order)) return;
  if (!order.channel_id || String(channelId) !== String(order.channel_id)) {
    throw new Error("請在原本的下單頻道繼續操作。");
  }
  const ids = selectedPlayerIds(order);
  if (ids.length && ids.length !== Number(order.player_count || 1)) {
    throw new Error("請先由客服在原頻道選齊陪陪，再確認報價與付款。");
  }
}

function requiresInChannelAcceptance(order) {
  return isInChannelOrder(order) && !String(order.preferred_player || "").trim();
}

function staffOrderChannelId(order, fallback, acceptanceChannel = fallback) {
  if (!isInChannelOrder(order)) return fallback;
  if (!order.channel_id) throw new Error("原頻道資料遺失，已停止送出訂單。");
  if (requiresInChannelAcceptance(order)) {
    if (!acceptanceChannel) throw new Error("未設定接單專區，已停止送出訂單。");
    return acceptanceChannel;
  }
  return order.channel_id;
}

module.exports = { MARKER, isInChannelOrder, selectedPlayerIds, assertInChannelSelection, staffOrderChannelId, requiresInChannelAcceptance };
