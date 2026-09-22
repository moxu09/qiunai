const test = require("node:test");
const assert = require("node:assert/strict");
const { getGeneralOrderAutoQuote, normalizeDeltaService, getValorantMappedCompanionRank } = require("../utils/generalOrderAutoQuote");

test("一般 Apex 訂單可依價目表自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "apex", itemLabel: "技術陪玩", rank: "白金", playerCount: 2, duration: 1.5 });
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 930);
  assert.equal(result.quote.unit, "小時");
});

test("一般英雄聯盟峽谷訂單使用局數自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "lol", itemLabel: "英雄聯盟", playMode: "大神陪玩", rank: "鑽石", playerCount: 1, rounds: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 1110);
  assert.equal(result.quote.unit, "局");
});

test("一般特戰娛樂訂單可自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "valorant", serviceTypes: ["娛樂"], rank: "白金", playerCount: 1, duration: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 520);
});

test("一般特戰直接依需求的陪陪段位自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "valorant", serviceTypes: ["頂輻"], valorantCompanionRank: "頂輻", rank: "銀牌", playerCount: 1, duration: 1 });
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
  const result = getGeneralOrderAutoQuote({ game: "STEAM", item: "一般遊戲陪玩", playerCount: 2, durationMinutes: 90 });
  assert.equal(result.ok, true);
  assert.equal(result.quote.total, 780);
});

test("資料不足或沒有價目表時轉客服", () => {
  const result = getGeneralOrderAutoQuote({ category: "other", playerCount: 1, duration: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /沒有自動價目表/);
});

test("計價單位不符時不自動報價", () => {
  const result = getGeneralOrderAutoQuote({ category: "lol", itemLabel: "英雄聯盟", playMode: "技術陪玩", rank: "白金", playerCount: 1, duration: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /應使用局計價/);
});

test("三角洲保底名稱可轉為價目表完整名稱", () => {
  assert.equal(normalizeDeltaService("機密雙護（有保底）"), "機密雙護保底");
});
