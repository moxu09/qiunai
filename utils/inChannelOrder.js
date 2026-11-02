const MARKER = "[IN_CHANNEL_ORDER]";

function isInChannelOrder(order) {
  return String(order?.note || "").includes(MARKER);
}

function isDirectAcceptanceOrder(order) {
  return isInChannelOrder(order) || String(order?.note || "").includes("[MANUAL_DISPATCH]");
}

function selectedPlayerIds(order) {
  return [...new Set(String(order?.preferred_player || "").split(",").map(id => id.trim()).filter(Boolean))];
}

function assertInChannelSelection(order, channelId = order?.channel_id) {
  if (!isDirectAcceptanceOrder(order)) return;
  if (!order.channel_id || String(channelId) !== String(order.channel_id)) {
    throw new Error("請在原本的下單頻道繼續操作。");
  }
  const ids = selectedPlayerIds(order);
  if (ids.length && ids.length !== Number(order.player_count || 1)) {
    throw new Error("請先由客服在原頻道選齊陪陪，再確認報價與付款。");
  }
}

function requiresInChannelAcceptance(order) {
  return isDirectAcceptanceOrder(order) && !String(order.preferred_player || "").trim();
}

function staffOrderChannelId(order, fallback, acceptanceChannelId) {
  if (requiresInChannelAcceptance(order)) {
    if (!order.channel_id) throw new Error("原訂單頻道資料遺失，已停止送出訂單。");
    if (!acceptanceChannelId) throw new Error("員工接單專區尚未設定，已停止送出訂單。");
    return acceptanceChannelId;
  }
  if (!isInChannelOrder(order)) return fallback;
  if (!order.channel_id) throw new Error("原頻道資料遺失，已停止送出訂單。");
  return order.channel_id;
}

module.exports = { MARKER, isInChannelOrder, isDirectAcceptanceOrder, selectedPlayerIds, assertInChannelSelection, staffOrderChannelId, requiresInChannelAcceptance };
