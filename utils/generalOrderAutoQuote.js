const { calculateSelfServicePrice } = require("../config/selfServicePricing");

function normalizeDeltaService(value) {
  return String(value || "")
    .replace("（有保底）", "保底")
    .replace("(有保底)", "保底")
    .trim();
}

function getValorantServiceType(pending) {
  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes.filter(Boolean)
    : [];
  if (serviceTypes.length === 1) return serviceTypes[0];
  const text = String(pending.serviceType || pending.itemLabel || "");
  if (/大神/.test(text)) return "大神";
  if (/技術/.test(text)) return "技術";
  if (/娛樂/.test(text)) return "娛樂";
  if (/頂輻/.test(text)) return "頂輻";
  if (/輻能/.test(text)) return "輻能";
  if (/神話/.test(text)) return "神話";
  if (/超凡/.test(text)) return "超凡";
  return "";
}

function getValorantMappedCompanionRank(serviceType, targetRank) {
  if (["超凡", "神話", "輻能", "頂輻"].includes(serviceType)) return serviceType;
  if (serviceType === "娛樂") return "娛樂";
  if (serviceType === "大神") return "頂輻";
  if (serviceType !== "技術") return null;
  const rank = String(targetRank || "");
  if (/神話|神[123]/.test(rank)) return "輻能";
  if (/超凡/.test(rank)) return "神話";
  return "超凡";
}

function getQuantity(pending) {
  const rounds = Number(pending.rounds || pending.gameCount || 0);
  if (rounds > 0) return { quantity: rounds, inputUnit: "局" };
  const duration = Number(pending.duration || 0);
  if (duration > 0) return { quantity: duration, inputUnit: "小時" };
  const durationMinutes = Number(pending.durationMinutes || 0);
  if (durationMinutes > 0) return { quantity: durationMinutes / 60, inputUnit: "小時" };
  throw new Error("尚未填寫可計算的時數或局數");
}

function getModernInput(pending, quantity) {
  const category = String(pending.category || "").toLowerCase();
  const playerCount = pending.playerCount;
  if (category === "apex") return { game: "apex", serviceType: pending.itemLabel || pending.playMode || pending.serviceType, rankOrMap: pending.rank, playerCount, quantity };
  if (category === "steam") return { game: "steam", platformOrMode: pending.steamCategory || pending.itemLabel, serviceType: "娛樂", rankOrMap: "一般", playerCount, quantity };
  if (category === "lol") return { game: "lol", platformOrMode: pending.itemLabel === "英雄聯盟" ? "召喚峽谷" : pending.itemLabel, serviceType: pending.playMode || pending.serviceType, rankOrMap: pending.rank, playerCount, quantity };
  if (category === "delta") return { game: "delta", platformOrMode: pending.deltaPlatform || pending.itemLabel, serviceType: normalizeDeltaService(pending.deltaMode || pending.serviceType), rankOrMap: pending.rank, playerCount, quantity };
  if (category === "valorant") {
    const serviceTypes = Array.isArray(pending.serviceTypes) ? pending.serviceTypes.filter(Boolean) : [];
    if (serviceTypes.includes("娛樂") && serviceTypes.length > 1) throw new Error("娛樂加技術的多人組合需由客服分項報價");
    const serviceType = getValorantServiceType(pending) || String(pending.serviceType || pending.itemLabel || "");
    const companionRank = pending.valorantCompanionRank || getValorantMappedCompanionRank(serviceType, pending.rank);
    if (!companionRank) throw new Error("特戰服務類型無法對應價目表");
    return { game: "valorant", platformOrMode: pending.playMode || "排位", serviceType: pending.rank, rankOrMap: companionRank, playerCount, quantity };
  }
  throw new Error("此服務目前沒有自動價目表");
}

function getLegacyInput(pending, quantity) {
  const game = String(pending.game || "");
  const playerCount = pending.playerCount;
  if (game === "STEAM") return { game: "steam", platformOrMode: pending.item, serviceType: "娛樂", rankOrMap: "一般", playerCount, quantity };
  if (game === "特戰英豪") {
    const type = getValorantServiceType({ serviceType: pending.item });
    const companionRank = getValorantMappedCompanionRank(type, pending.rank);
    if (!companionRank) throw new Error("特戰服務類型無法對應價目表");
    return { game: "valorant", platformOrMode: "排位", serviceType: pending.rank, rankOrMap: companionRank, playerCount, quantity };
  }
  throw new Error("目前表單資料不足以套用自動價目表");
}

function getGeneralOrderAutoQuote(pending = {}) {
  try {
    const { quantity, inputUnit } = getQuantity(pending);
    const input = pending.category ? getModernInput(pending, quantity) : getLegacyInput(pending, quantity);
    const quote = calculateSelfServicePrice(input);
    if (quote.unit !== inputUnit) throw new Error(`此組合應使用${quote.unit}計價，但訂單填寫的是${inputUnit}`);
    return { ok: true, input, quote };
  } catch (error) {
    return { ok: false, reason: error?.message || "目前無法自動計算價格" };
  }
}

module.exports = { getGeneralOrderAutoQuote, normalizeDeltaService, getValorantMappedCompanionRank };
