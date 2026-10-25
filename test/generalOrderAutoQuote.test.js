const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateSelfServicePrice, getValorantExpectedUnit } = require("../config/selfServicePricing");
test("特戰 NG 段位即使留有技術陪陪等級，也必須使用娛樂新價", () => {
  for (const rank of ["NG", "ng", "一般"]) {
    const result = getGeneralOrderAutoQuote({ category: "valorant", serviceTypes: ["技術"], valorantCompanionRank: "頂輻", rank, playerCount: 2, duration: 1.5 });
    assert.equal(result.ok, true);
    assert.equal(result.quote.unitPrice, 280);
    assert.equal(result.quote.total, 840);
    assert.equal(result.quote.unit, "小時");
  }
});

test("特戰 NG 服務類型兼容新舊表單", () => {
  for (const pending of [
    { category: "valorant", serviceTypes: ["NG"], rank: "黃金以下", duration: 1 },
    { game: "特戰英豪", item: "NG", rank: "黃金以下", durationMinutes: 60 },
    { game: "特戰英豪", item: "技術", rank: "NG", durationMinutes: 60 },
  ]) {
    const result = getGeneralOrderAutoQuote({ ...pending, playerCount: 1 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.quote.total, 280);
  }
});

test("特戰一般模式使用對應段位娛樂價及小時計價，不影響排位", () => {
  const input = { game: "valorant", platformOrMode: "一般", serviceType: "白金", rankOrMap: "頂輻", playerCount: 1, quantity: 1.5, pricingDate: "2026-10-01T00:00:00+08:00" };
  assert.equal(getValorantExpectedUnit(input), "小時");
  assert.equal(calculateSelfServicePrice(input).total, 450);
  assert.equal(calculateSelfServicePrice({ ...input, platformOrMode: "排位", quantity: 2 }).total, 560);
  assert.equal(calculateSelfServicePrice({ ...input, serviceType: "NG", pricingDate: "2026-09-30T23:59:59+08:00" }).unitPrice, 250);
});
const { getGeneralOrderAutoQuote, normalizeDeltaService, getValorantMappedCompanionRank } = require("../utils/generalOrderAutoQuote");
const before = "2026-09-30T15:59:59.999Z";
const effective = "2026-09-30T16:00:00.000Z";

test("一般 Apex 訂單可依價目表自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "apex", itemLabel: "技術陪玩", rank: "白金", playerCount: 2, duration: 1.5 }, before);
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 930);
  assert.equal(result.quote.unit, "小時");
});

test("一般英雄聯盟峽谷訂單使用局數自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "lol", itemLabel: "英雄聯盟", playMode: "大神陪玩", rank: "鑽石", playerCount: 1, rounds: 3 }, before);
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 1110);
  assert.equal(result.quote.unit, "局");
});

test("一般特戰娛樂訂單可自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "valorant", serviceTypes: ["娛樂"], rank: "白金", playerCount: 1, duration: 2 }, before);
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 520);
});

test("一般特戰直接依需求的陪陪段位自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "valorant", serviceTypes: ["頂輻"], valorantCompanionRank: "頂輻", rank: "銀牌", playerCount: 1, duration: 1 }, before);
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 330);
  assert.equal(result.quote.unit, "小時");
});

test("特戰陪陪段位沿用價目表選項並兼容舊服務類型", () => {
  assert.equal(getValorantMappedCompanionRank("超凡", "銀牌"), "超凡");
  assert.equal(getValorantMappedCompanionRank("神話", "白金"), "神話");
  assert.equal(getValorantMappedCompanionRank("輻能", "鑽石"), "輻能");
  assert.equal(getValorantMappedCompanionRank("頂輻", "超凡"), "頂輻");
  assert.equal(getValorantMappedCompanionRank("大神", "銀牌"), "頂輻");
  assert.equal(getValorantMappedCompanionRank("技術", "銀牌"), "超凡");
  assert.equal(getValorantMappedCompanionRank("技術", "超凡"), "神話");
  assert.equal(getValorantMappedCompanionRank("技術", "神話"), "輻能");
  assert.equal(getValorantMappedCompanionRank("娛樂", "鑽石"), "娛樂");
});

test("舊版一般 STEAM 訂單也可自動報價", () => {
  const result = getGeneralOrderAutoQuote({ game: "STEAM", item: "一般遊戲陪玩", playerCount: 2, durationMinutes: 90 }, before);
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 780);
});

test("資料不足或沒有價目表時轉客服", () => {
  const result = getGeneralOrderAutoQuote({ category: "other", playerCount: 1, duration: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /沒有自動價目表/);
});

test("計價單位不符時不自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "lol", itemLabel: "英雄聯盟", playMode: "技術陪玩", rank: "白金", playerCount: 1, duration: 1 }, before);
  assert.equal(result.ok, false);
  assert.match(result.reason, /應使用局計價/);
});

test("三角洲保底名稱可轉為價目表完整名稱", () => {
  assert.equal(normalizeDeltaService("機密雙護（有保底）"), "機密雙護保底");
});

test("10/01 起一般單自動報價與六張新價目同步", () => {
  const apex = getGeneralOrderAutoQuote({ category: "apex", itemLabel: "技術陪玩", rank: "白金", playerCount: 2, duration: 1.5 }, effective);
  assert.equal(apex.quote.total, 990);
  const lol = getGeneralOrderAutoQuote({ category: "lol", itemLabel: "英雄聯盟", playMode: "娛樂", rank: "娛樂", playerCount: 1, duration: 1.5 }, effective);
  assert.equal(lol.quote.total, 390);
  assert.equal(lol.quote.unit, "小時");
  const delta = getGeneralOrderAutoQuote({ category: "delta", deltaPlatform: "電腦版", deltaMode: "保底單 800w｜雙護", playerCount: 2, rounds: 2 }, effective);
  assert.equal(delta.quote.total, 1400);
  assert.equal(delta.quote.unit, "單");
  const deltaHourly = getGeneralOrderAutoQuote({ category: "delta", deltaPlatform: "手機版", deltaMode: "機密｜資深", playerCount: 1, duration: 2 }, effective);
  assert.equal(deltaHourly.quote.total, 820);
  const voice = getGeneralOrderAutoQuote({ category: "voice_chat", playMode: "日常聊天", playerCount: 1, duration: 0.5 }, effective);
  assert.equal(voice.quote.total, 175);
});
