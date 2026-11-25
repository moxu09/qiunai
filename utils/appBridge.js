// Signed /app/* endpoints for the customer APP (via app-api). Read-only: price table and
// display-only estimates computed by the bot's own selfServicePricing. Never creates orders.
const { authenticate } = require("./websiteOrderBridge");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FALLBACK_REASON = "暫時無法自動試算，送出後由客服報價";

// APP game labels (mobile Order.tsx GAMES + /app/pricing labels) -> bridge game keys.
const APP_GAME_ALIASES = [
  ["valorant", ["特戰英豪", "特戰", "valorant"]],
  ["delta", ["三角洲行動", "三角洲", "delta"]],
  ["apex", ["Apex 英雄", "Apex", "Apex Legends"]],
  ["lol", ["英雄聯盟", "召喚峽谷", "lol"]],
  ["aram", ["ARAM", "咆哮深淵"]],
  ["tft", ["聯盟戰棋", "戰棋", "tft"]],
  ["steam", ["Steam 多人", "Steam"]],
  ["voice_chat", ["語音聊天"]],
];

// APP rank labels that the bot's RANK_ALIASES / VALORANT_COMPANION_ALIASES do not know yet,
// rewritten to a label the bot already resolves. Only unambiguous tiers are listed.
const APP_RANK_LABELS = {
  valorantTarget: { 黃金含以下: "黃金以下" },
  valorantCompanion: { 鐵牌: "黃金以下", 銅牌: "黃金以下", 銀牌: "黃金以下", 黃金含以下: "黃金以下" },
  apex: { 銅牌: "青銅", 銀牌: "白銀", 金牌: "黃金", 獵殺: "頂獵", 黃金含以下: "黃金以下" },
  lol: { 鐵牌: "黑鐵", 銀牌: "白銀", 金牌: "黃金", 白金含以下: "白金以下" },
};

const VALORANT_TARGET_LABELS = { gold: "黃金含以下", platinum: "白金", diamond: "鑽石", ascendant: "超凡", immortal12: "神話 1至2", immortal3: "神話 3" };
const APEX_RANK_LABELS = { general: "一般", gold: "黃金含以下", platinum: "白金", diamond: "鑽石", master: "大師", predator: "頂獵" };
const LOL_RANK_LABELS = { general: "一般", platinum: "白金含以下", emerald: "翡翠", diamond: "鑽石", master: "大師", grandmaster: "宗師", challenger: "菁英" };
const TYPE_LABELS = { entertain: "娛樂", skill: "技術", god: "大神" };

function commonUnit(rows) {
  const units = [...new Set(rows.map(row => row.unit))];
  return units.length === 1 ? units[0] : "小時／局";
}

function service(key, label, rows, unit = commonUnit(rows)) {
  return { key, label, unit, rows };
}

function tableByType(prices, rankLabels, typeKeys, unitFor) {
  return Object.keys(typeKeys)
    .map(type => {
      const rows = Object.keys(rankLabels)
        .filter(rank => prices?.[rank]?.[type])
        .map(rank => ({ label: rankLabels[rank], price: prices[rank][type], unit: unitFor(rank, type) }));
      return service(type, typeKeys[type], rows);
    })
    .filter(item => item.rows.length > 0);
}

function buildPricing(P) {
  const catalog = P.getCompanyAiPricingCatalog();
  const october = P.isOctoberValorantPricingActive();
  const levelLabels = catalog.valorant.companionLevelKeys;
  const valorant = Object.keys(VALORANT_TARGET_LABELS)
    .filter(rank => catalog.valorant.prices[rank])
    .map(rank => {
      const prices = catalog.valorant.prices[rank];
      const rows = Object.keys(levelLabels)
        .filter(level => prices[level])
        .map(level => ({ label: levelLabels[level], price: prices[level][0], unit: prices[level][1] }));
      return service(rank, VALORANT_TARGET_LABELS[rank], rows);
    });
  const deltaRows = catalog.delta.services.map(item => ({ label: item.name, price: item.price, unit: item.unit, fixedPlayerCount: item.fixedPlayerCount }));
  const voicePrice = typeof catalog.voiceChat.pricing === "number" ? catalog.voiceChat.pricing : null;
  return {
    effectiveFrom: catalog.valorant.effectiveVersion,
    games: [
      { key: "valorant", label: "特戰英豪", services: valorant },
      {
        key: "delta",
        label: "三角洲行動",
        services: [
          service("hourly", "計時陪玩", deltaRows.filter(row => !row.label.includes("保底"))),
          service("guaranteed", "保底單（固定 2 位陪陪）", deltaRows.filter(row => row.label.includes("保底"))),
        ].filter(item => item.rows.length > 0),
      },
      { key: "apex", label: "Apex 英雄", services: tableByType(catalog.apex.prices, APEX_RANK_LABELS, catalog.apex.typeKeys, () => "小時") },
      {
        key: "lol",
        label: "英雄聯盟",
        services: tableByType(catalog.lol.summonRift.prices, LOL_RANK_LABELS, catalog.lol.summonRift.typeKeys,
          (rank, type) => (october && rank === "general" && type === "entertain" ? "小時" : "局")),
      },
      {
        key: "aram",
        label: "ARAM",
        services: [service("aram", "ARAM", Object.keys(TYPE_LABELS)
          .filter(type => catalog.lol.aram.prices[type])
          .map(type => ({ label: TYPE_LABELS[type], price: catalog.lol.aram.prices[type], unit: "小時" })))],
      },
      { key: "tft", label: "聯盟戰棋", services: tableByType(catalog.lol.tft.prices, LOL_RANK_LABELS, catalog.lol.tft.typeKeys, () => "局") },
      { key: "steam", label: "Steam 多人", services: [service("standard", "陪玩", [{ label: "每位陪陪", price: catalog.steam.price, unit: "小時" }])] },
      {
        key: "voice_chat",
        label: "語音聊天",
        services: [service("standard", "聊天陪伴", [{ label: voicePrice === null ? "由客服正式報價" : "每位陪陪", price: voicePrice, unit: "小時" }], "小時")],
      },
    ],
  };
}

function chineseReason(message) {
  const text = String(message || "");
  return /[一-鿿]/.test(text) ? text : FALLBACK_REASON;
}

function validEstimateBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.game !== "string" || !value.game.trim() || value.game.length > 80) return false;
  const optionalText = ["serviceType", "targetRank", "companionRank", "unit", "platform"]
    .every(key => value[key] == null || (typeof value[key] === "string" && value[key].length <= 80));
  const numberLike = ["amount", "companionCount"]
    .every(key => typeof value[key] === "number" || (typeof value[key] === "string" && value[key].length <= 20));
  return optionalText && numberLike;
}

function estimatePrice(P, body) {
  const fail = reason => ({ amount: null, reason: chineseReason(reason) });
  const game = P.match(body.game, APP_GAME_ALIASES);
  if (!game) return fail("不支援的遊戲");
  const appRank = (table, label) => {
    const text = String(label || "").trim();
    return APP_RANK_LABELS[table][P.normalize(text)] || text;
  };
  const base = { quantity: body.amount, playerCount: body.companionCount };
  let input;
  if (game === "valorant") {
    const target = appRank("valorantTarget", body.targetRank);
    // The bot treats an unknown target rank as 黃金; an APP label it can't map must not be priced as 黃金.
    if (target && !P.match(target, P.RANK_ALIASES.valorant)) return fail("段位不在目前自動報價範圍內");
    const companion = appRank("valorantCompanion", body.companionRank);
    const level = companion || (P.match(body.serviceType, P.TYPE_ALIASES) === "entertain" ? "娛樂" : "");
    input = { ...base, game: "valorant", serviceType: target, rankOrMap: level, platformOrMode: "" };
  } else if (game === "delta") {
    // Platform does not change the delta price; the bot only requires 電腦 or 手機.
    const platformOrMode = P.normalize(body.platform) === P.normalize("手機") ? "手機" : "電腦";
    input = { ...base, game: "delta", platformOrMode, serviceType: body.serviceType };
  } else if (game === "apex") {
    input = { ...base, game: "apex", serviceType: body.serviceType, rankOrMap: appRank("apex", body.targetRank) };
  } else if (game === "lol" || game === "tft") {
    input = { ...base, game: "lol", platformOrMode: game === "lol" ? "召喚峽谷" : "tft", serviceType: body.serviceType, rankOrMap: appRank("lol", body.targetRank) };
  } else if (game === "aram") {
    input = { ...base, game: "lol", platformOrMode: "aram", serviceType: body.serviceType };
  } else {
    input = { ...base, game };
  }
  let result;
  try {
    result = P.calculateSelfServicePrice(input);
  } catch (error) {
    return fail(error?.message);
  }
  const units = ["小時", "局"];
  if (units.includes(body.unit) && units.includes(result.unit) && body.unit !== result.unit) {
    return fail(`此組合以「${result.unit}」計價，請改選「${result.unit}」後再試算`);
  }
  return { amount: result.total, unit: result.unit, unitPrice: result.unitPrice };
}

function createAppBridge({ token, pricing = require("../config/selfServicePricing"), ai } = {}) {
  void ai; // reserved for /app/ai/* (Task 2)
  async function handleHttpRequest(request, response) {
    if (!request.url?.startsWith("/app/")) return false;
    const reply = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
      return true;
    };
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return reply(413, { error: "payload_too_large" });
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks).toString();
    if (!authenticate(request, body, token)) return reply(401, { error: "unauthorized" });
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/app/pricing") {
      if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
      return reply(200, buildPricing(pricing));
    }
    if (path === "/app/pricing/estimate") {
      if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
      let value;
      try { value = JSON.parse(body); } catch { return reply(400, { error: "invalid_json" }); }
      if (!validEstimateBody(value)) return reply(400, { error: "invalid_request" });
      return reply(200, estimatePrice(pricing, value));
    }
    return reply(404, { error: "not_found" });
  }
  return { handleHttpRequest };
}

module.exports = { createAppBridge, buildPricing, estimatePrice, APP_GAME_ALIASES, APP_RANK_LABELS };
