const GAME_OPTIONS = [
  { label: "特戰英豪", value: "valorant", description: "VALORANT" },
  { label: "三角洲行動", value: "delta", description: "電腦版 / 手機版" },
  { label: "Apex", value: "apex", description: "Apex Legends" },
  { label: "英雄聯盟", value: "lol", description: "峽谷 / ARAM / 聯盟戰棋" },
  { label: "Steam", value: "steam", description: "Steam 遊戲陪玩" },
  { label: "語音聊天", value: "voice_chat", description: "語音陪伴 / 聊天服務" },
];

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s　_()（）/\\｜|+-]/g, "");
}

function match(value, aliases) {
  const target = normalize(value);
  return aliases.find(([key, values]) =>
    [key, ...values].some((alias) => normalize(alias) === target),
  )?.[0];
}

const TYPE_ALIASES = [
  ["entertain", ["娛樂", "娛樂陪玩"]],
  ["skill", ["技術", "技術陪玩"]],
  ["god", ["大神", "大神陪玩"]],
];

const RANK_ALIASES = {
  valorant: [
    ["gold", ["黃金以下", "金牌以下", "黃金", "金牌", "白銀", "銀牌", "青銅", "銅牌", "鐵牌", "一般", "ng"]],
    ["platinum", ["白金"]],
    ["diamond", ["鑽石"]],
    ["ascendant", ["超凡"]],
    ["immortal12", ["神1", "神2", "神話1", "神話2", "神1至2", "神話1至2"]],
    ["immortal3", ["神3", "神話3"]],
  ],
  apex: [
    ["general", ["一般", "娛樂", "ng"]],
    ["gold", ["黃金以下", "黃金", "白銀", "青銅", "菜鳥"]],
    ["platinum", ["白金"]],
    ["diamond", ["鑽石"]],
    ["master", ["大師"]],
    ["predator", ["頂獵", "頂尖獵殺者"]],
  ],
  lol: [
    ["general", ["一般", "娛樂", "ng"]],
    ["platinum", ["白金以下", "白金", "黃金", "白銀", "銅牌", "黑鐵"]],
    ["emerald", ["翡翠"]],
    ["diamond", ["鑽石"]],
    ["master", ["大師"]],
    ["grandmaster", ["宗師"]],
    ["challenger", ["菁英"]],
  ],
  tft: [
    ["general", ["一般", "娛樂"]],
    ["platinum", ["白金以下", "白金", "黃金", "白銀", "銅牌", "黑鐵"]],
    ["emerald", ["翡翠"]],
    ["diamond", ["鑽石"]],
    ["master", ["大師"]],
    ["grandmaster", ["宗師"]],
    ["challenger", ["菁英"]],
  ],
};

const VALORANT_COMPANION_ALIASES = [
  ["gold", ["黃金以下", "金牌以下", "黃金", "金牌"]],
  ["platinum", ["白金"]],
  ["diamond", ["鑽石"]],
  ["ascendant", ["超凡", "超凡陪"]],
  ["immortal", ["神話", "神話陪"]],
  ["radiant", ["輻能", "輻能陪"]],
  ["topRadiant", ["頂輻", "頂輻陪"]],
  ["entertain", ["娛樂", "娛樂陪玩"]],
];

const VALORANT_RANKED_COMPANIONS = [
  { key: "gold", label: "黃金含以下" },
  { key: "platinum", label: "白金" },
  { key: "diamond", label: "鑽石" },
  { key: "ascendant", label: "超凡" },
  { key: "immortal", label: "神話" },
  { key: "radiant", label: "輻能" },
  { key: "topRadiant", label: "頂輻" },
];

const PRICES = {
  valorant: {
    gold: { entertain: [250, "小時"], ascendant: [260, "小時"], immortal: [270, "小時"], radiant: [300, "小時"], topRadiant: [330, "小時"] },
    platinum: { entertain: [260, "小時"], ascendant: [190, "局"], immortal: [210, "局"], radiant: [230, "局"], topRadiant: [250, "局"] },
    diamond: { entertain: [270, "小時"], ascendant: [220, "局"], immortal: [240, "局"], radiant: [250, "局"], topRadiant: [275, "局"] },
    ascendant: { entertain: [310, "小時"], immortal: [250, "局"], radiant: [270, "局"], topRadiant: [295, "局"] },
    immortal12: { radiant: [330, "局"], topRadiant: [360, "局"] },
    immortal3: { radiant: [350, "局"], topRadiant: [385, "局"] },
  },
  apex: {
    general: { entertain: 260, skill: 280, god: 320 },
    gold: { entertain: 270, skill: 290, god: 330 },
    platinum: { entertain: 280, skill: 310, god: 335 },
    diamond: { skill: 320, god: 355 },
    master: { god: 380 },
    predator: { god: 410 },
  },
  lol: {
    general: { entertain: 240, skill: 250, god: 260 },
    platinum: { entertain: 250, skill: 270, god: 300 },
    emerald: { skill: 300, god: 320 },
    diamond: { skill: 320, god: 370 },
    master: { skill: 350, god: 420 },
    grandmaster: { skill: 370, god: 470 },
    challenger: { god: 520 },
  },
  tft: {
    general: { entertain: 250, skill: 270 },
    platinum: { entertain: 270, skill: 280 },
    emerald: { skill: 290 },
    diamond: { skill: 310 },
    master: { skill: 330 },
    grandmaster: { skill: 350 },
  },
};

const VALORANT_PRICING_2026_10_EFFECTIVE_AT = Date.parse("2026-09-30T16:00:00.000Z");
const VALORANT_PRICES_2026_10 = {
  gold: { entertain: [280, "小時"], ascendant: [300, "小時"], immortal: [320, "小時"], radiant: [340, "小時"], topRadiant: [360, "小時"] },
  platinum: { entertain: [300, "小時"], ascendant: [240, "局"], immortal: [250, "局"], radiant: [260, "局"], topRadiant: [280, "局"] },
  diamond: { entertain: [320, "小時"], ascendant: [260, "局"], immortal: [270, "局"], radiant: [280, "局"], topRadiant: [300, "局"] },
  ascendant: { entertain: [350, "小時"], immortal: [290, "局"], radiant: [300, "局"], topRadiant: [340, "局"] },
  immortal12: { radiant: [330, "局"], topRadiant: [360, "局"] },
  immortal3: { radiant: [350, "局"], topRadiant: [385, "局"] },
};

function getPricingTimestamp(value = new Date()) {
  if (value instanceof Date) return value.getTime();
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function isOctoberValorantPricingActive(value = new Date()) {
  return getPricingTimestamp(value) >= VALORANT_PRICING_2026_10_EFFECTIVE_AT;
}

function getActiveValorantPrices(value = new Date()) {
  return isOctoberValorantPricingActive(value)
    ? VALORANT_PRICES_2026_10
    : PRICES.valorant;
}

const DELTA_SERVICE_OPTIONS = [
  { label: "娛樂陪玩", value: "娛樂陪玩", key: "entertain", price: 280 },
  { label: "機密雙護", value: "機密雙護", key: "secret", price: 600 },
  { label: "機密雙護保底", value: "機密雙護保底", key: "secret_guaranteed", price: 800 },
  { label: "猛攻護航", value: "猛攻護航", key: "assault", price: 700 },
  { label: "猛攻護航保底", value: "猛攻護航保底", key: "assault_guaranteed", price: 1100 },
];

function getDeltaServiceOption(value) {
  const target = String(value || "").trim();
  return DELTA_SERVICE_OPTIONS.find((option) => option.value === target) || null;
}

function getDeltaFixedPlayerCount(value) {
  return getDeltaServiceOption(value)?.value.includes("雙護") ? 2 : null;
}

function positiveNumber(value, label) {
  const number = Number(String(value || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label}請輸入大於 0 的數字`);
  }
  return number;
}

function calculateTablePrice(game, rankText, typeText, quantity, playerCount) {
  const rank = match(rankText, RANK_ALIASES[game]);
  const type = match(typeText, TYPE_ALIASES);
  if (!rank) throw new Error("段位不在目前自動報價範圍內");
  if (!type) throw new Error("類型請填娛樂、技術或大神");
  const unitPrice = PRICES[game]?.[rank]?.[type];
  if (!unitPrice) throw new Error("目前價目表沒有這個段位與類型的組合");
  return { unitPrice, total: unitPrice * quantity * playerCount, unit: "小時" };
}

function getValorantExpectedUnit(input) {
  const rank = match(input.serviceType, RANK_ALIASES.valorant) || "gold";
  const level = match(input.rankOrMap, VALORANT_COMPANION_ALIASES);
  return rank === "gold" || level === "entertain" ? "小時" : "局";
}

function getValorantCompanionOptions(targetRankText, pricingDate) {
  const rank = match(targetRankText, RANK_ALIASES.valorant) || "gold";
  const minimumIndex = {
    gold: 0,
    platinum: 1,
    diamond: 2,
    ascendant: 3,
    immortal12: 4,
    immortal3: 4,
  }[rank] ?? 0;
  const options = VALORANT_RANKED_COMPANIONS.slice(minimumIndex).map(
    ({ label }) => ({ label, value: label }),
  );
  if (getActiveValorantPrices(pricingDate)?.[rank]?.entertain) {
    options.unshift({ label: "娛樂", value: "娛樂" });
  }
  return options;
}

function calculateSelfServicePrice(input) {
  const game = normalize(input.game);
  const count = positiveNumber(input.playerCount, "陪陪人數");
  if (!Number.isInteger(count) || count > 8) {
    throw new Error("陪陪人數限 1 至 8 位整數");
  }
  const quantity = positiveNumber(input.quantity, "時數／局數");

  if (game === "voicechat") {
    if (!Number.isInteger(quantity * 2)) {
      throw new Error("語音聊天時數請以 0.5 小時為單位");
    }
    throw new Error("語音聊天尚缺自動報價，已轉客服正式報價");
  }

  if (game === "apex") {
    return { ...calculateTablePrice("apex", input.rankOrMap, input.serviceType, quantity, count), quantity, playerCount: count };
  }

  if (game === "steam") {
    return { unitPrice: 260, total: 260 * quantity * count, unit: "小時", quantity, playerCount: count };
  }

  if (game === "delta") {
    const platform = match(input.platformOrMode, [
      ["pc", ["電腦", "電腦版", "pc"]],
      ["mobile", ["手機", "手機版", "mobile"]],
    ]);
    if (!platform) throw new Error("三角洲平台請填電腦或手機");
    const serviceOption = getDeltaServiceOption(input.serviceType);
    if (!serviceOption) {
      throw new Error(
        `三角洲項目請輸入完整名稱：${DELTA_SERVICE_OPTIONS.map(({ value }) => value).join("、")}`,
      );
    }
    if (!String(input.rankOrMap || "").trim()) throw new Error("三角洲必須填寫地圖");
    return { unitPrice: serviceOption.price, total: serviceOption.price * quantity * count, unit: "小時", quantity, playerCount: count, platform };
  }

  if (game === "lol") {
    const mode = match(input.platformOrMode, [
      ["lol", ["召喚峽谷", "峽谷", "lol"]],
      ["aram", ["aram", "咆哮深淵"]],
      ["tft", ["tft", "聯盟戰棋", "戰棋"]],
    ]);
    if (mode === "aram") {
      const type = match(input.serviceType, TYPE_ALIASES);
      const unitPrice = { entertain: 260, skill: 340, god: 400 }[type];
      if (!unitPrice) throw new Error("ARAM 類型請填娛樂、技術或大神");
      return { unitPrice, total: unitPrice * quantity * count, unit: "小時", quantity, playerCount: count, mode };
    }
    if (mode === "tft") {
      if (!Number.isInteger(quantity)) throw new Error("聯盟戰棋局數必須是整數");
      return { ...calculateTablePrice("tft", input.rankOrMap, input.serviceType, quantity, count), unit: "局", quantity, playerCount: count, mode };
    }
    if (mode === "lol") {
      if (!Number.isInteger(quantity)) throw new Error("召喚峽谷局數必須是整數");
      const result = calculateTablePrice("lol", input.rankOrMap, input.serviceType, quantity, count);
      return { ...result, unit: "局", quantity, playerCount: count, mode };
    }
    throw new Error("英雄聯盟模式請填召喚峽谷、ARAM 或聯盟戰棋");
  }

  if (game === "valorant") {
    const rank = match(input.serviceType, RANK_ALIASES.valorant) || "gold";
    const level = match(input.rankOrMap, VALORANT_COMPANION_ALIASES);
    if (!level) {
      throw new Error(
        "需求的陪陪段位請選擇與要打的段位同階或更高段位",
      );
    }
    if (level !== "entertain") {
      const minimumIndex = {
        gold: 0,
        platinum: 1,
        diamond: 2,
        ascendant: 3,
        immortal12: 4,
        immortal3: 4,
      }[rank] ?? 0;
      const companionIndex = VALORANT_RANKED_COMPANIONS.findIndex(
        (item) => item.key === level,
      );
      if (companionIndex < minimumIndex) {
        throw new Error("需求的陪陪段位不可低於要打的段位");
      }
    }
    const price = getActiveValorantPrices(input.pricingDate)?.[rank]?.[level];
    if (!price) throw new Error("目前價目表沒有這個特戰段位與陪陪等級組合");
    const [unitPrice, unit] = price;
    if (unit === "局" && !Number.isInteger(quantity)) throw new Error("局數必須是整數");
    return { unitPrice, total: unitPrice * quantity * count, unit, quantity, playerCount: count };
  }

  throw new Error("不支援的遊戲");
}

function getCompanyAiPricingCatalog() {
  return {
    source: "秋奈自助下單現行價目表",
    currency: "NTD",
    formula: "總價 = 單價 × 時數或局數 × 陪陪人數",
    valorant: {
      targetRankRules: {
        gold: "要打的段位為黃金含以下；娛樂或此級距使用小時計價",
        platinum: "要打的段位為白金",
        diamond: "要打的段位為鑽石",
        ascendant: "要打的段位為超凡",
        immortal12: "要打的段位為神話 1 至 2",
        immortal3: "要打的段位為神話 3",
      },
      companionLevelKeys: {
        entertain: "娛樂",
        gold: "黃金含以下",
        platinum: "白金",
        diamond: "鑽石",
        ascendant: "超凡",
        immortal: "神話",
        radiant: "輻能",
        topRadiant: "頂輻",
      },
      selectionRule:
        "需求的陪陪段位最低可與要打的段位同階，不可低於；現行價目表沒有金額的同階組合會轉 AI 輔助與客服正式報價。",
      effectiveVersion: isOctoberValorantPricingActive() ? "2026-10-01" : "current",
      prices: getActiveValorantPrices(),
    },
    apex: {
      unit: "小時",
      typeKeys: { entertain: "娛樂", skill: "技術", god: "大神" },
      prices: PRICES.apex,
    },
    lol: {
      summonRift: {
        unit: "局",
        typeKeys: { entertain: "娛樂", skill: "技術", god: "大神" },
        prices: PRICES.lol,
      },
      aram: {
        unit: "小時",
        prices: { entertain: 260, skill: 340, god: 400 },
      },
      tft: {
        unit: "局",
        typeKeys: { entertain: "娛樂", skill: "技術" },
        prices: PRICES.tft,
      },
    },
    delta: {
      unit: "小時",
      services: DELTA_SERVICE_OPTIONS.map(({ value, price }) => ({
        name: value,
        price,
        fixedPlayerCount: value.includes("雙護") ? 2 : null,
      })),
    },
    steam: { unit: "小時", price: 260 },
    voiceChat: {
      unit: "小時",
      minimumBillingUnit: 0.5,
      pricing: "由客服依聊天需求正式報價",
    },
  };
}

module.exports = {
  DELTA_SERVICE_OPTIONS,
  GAME_OPTIONS,
  calculateSelfServicePrice,
  getDeltaFixedPlayerCount,
  getValorantCompanionOptions,
  getValorantExpectedUnit,
  getCompanyAiPricingCatalog,
  getActiveValorantPrices,
  isOctoberValorantPricingActive,
  VALORANT_PRICING_2026_10_EFFECTIVE_AT,
};
