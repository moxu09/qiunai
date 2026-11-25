const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const pricing = require("../config/selfServicePricing");

const TOKEN = "test-bot-token";

function sign(method, url, body, time = String(Date.now()), token = TOKEN) {
  const signature = createHmac("sha256", token)
    .update(`qiunai-website-v1\n${time}\n${method}\n${url}\n${body}`)
    .digest("hex");
  return { "x-website-time": time, "x-website-signature": signature };
}

function fakeRequest(method, url, body = "", headers = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function fakeResponse() {
  return {
    status: null,
    headers: null,
    text: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.text = text || ""; },
    get json() { return JSON.parse(this.text); },
  };
}

async function call(bridge, method, url, data, { signed = true, headers } = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  const request = fakeRequest(method, url, body, headers || (signed ? sign(method, url, body) : {}));
  const response = fakeResponse();
  const handled = await bridge.handleHttpRequest(request, response);
  return { handled, response };
}

const bridge = () => createAppBridge({ token: TOKEN });
const estimate = data => call(bridge(), "POST", "/app/pricing/estimate", data);

test("non /app/ paths are not handled", async () => {
  const { handled, response } = await call(bridge(), "GET", "/website/orders/health", undefined);
  assert.equal(handled, false);
  assert.equal(response.status, null);
});

test("unsigned or wrongly signed /app requests get 401", async () => {
  const unsigned = await call(bridge(), "GET", "/app/pricing", undefined, { signed: false });
  assert.equal(unsigned.handled, true);
  assert.equal(unsigned.response.status, 401);
  const wrong = await call(bridge(), "GET", "/app/pricing", undefined, { headers: sign("GET", "/app/pricing", "", String(Date.now()), "other-token") });
  assert.equal(wrong.response.status, 401);
  const stale = await call(bridge(), "GET", "/app/pricing", undefined, { headers: sign("GET", "/app/pricing", "", String(Date.now() - 61000)) });
  assert.equal(stale.response.status, 401);
  const tampered = fakeRequest("POST", "/app/pricing/estimate", '{"game":"Apex 英雄"}', sign("POST", "/app/pricing/estimate", "{}"));
  const response = fakeResponse();
  await bridge().handleHttpRequest(tampered, response);
  assert.equal(response.status, 401);
  const noToken = await call(createAppBridge({ token: "" }), "GET", "/app/pricing", undefined);
  assert.equal(noToken.response.status, 401);
});

test("oversized bodies are rejected", async () => {
  const big = "x".repeat(2 * 1024 * 1024 + 1);
  const request = fakeRequest("POST", "/app/pricing/estimate", big, sign("POST", "/app/pricing/estimate", big));
  const response = fakeResponse();
  await bridge().handleHttpRequest(request, response);
  assert.equal(response.status, 413);
});

test("GET /app/pricing returns the bot's active price table with Chinese labels", async () => {
  const { handled, response } = await call(bridge(), "GET", "/app/pricing", undefined);
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  const data = response.json;
  assert.equal(data.effectiveFrom, pricing.getCompanyAiPricingCatalog().valorant.effectiveVersion);
  const keys = data.games.map(g => g.key);
  assert.deepEqual(keys, ["valorant", "delta", "apex", "lol", "aram", "tft", "steam", "voice_chat"]);
  for (const game of data.games) {
    assert.equal(typeof game.label, "string");
    assert.ok(game.services.length > 0, game.key);
    for (const service of game.services) {
      assert.equal(typeof service.key, "string");
      assert.equal(typeof service.label, "string");
      assert.equal(typeof service.unit, "string");
      for (const row of service.rows) {
        assert.equal(typeof row.label, "string");
        assert.ok(row.price === null || Number.isFinite(row.price));
      }
    }
  }
  const valorant = data.games.find(g => g.key === "valorant");
  const platinum = valorant.services.find(s => s.key === "platinum");
  const active = pricing.getActiveValorantPrices();
  assert.deepEqual(platinum.rows.find(r => r.label === "超凡"), { label: "超凡", price: active.platinum.ascendant[0], unit: active.platinum.ascendant[1] });
  const apex = data.games.find(g => g.key === "apex");
  assert.equal(apex.services.find(s => s.key === "skill").rows.find(r => r.label === "鑽石").price, pricing.getActivePrices("apex").diamond.skill);
  const delta = data.games.find(g => g.key === "delta");
  const deltaOptions = pricing.getActiveDeltaServiceOptions();
  const guaranteed = delta.services.find(s => s.key === "guaranteed");
  const hourly = delta.services.find(s => s.key === "hourly");
  assert.ok(guaranteed.rows.length > 0 && hourly.rows.length > 0);
  assert.equal(guaranteed.rows.length + hourly.rows.length, deltaOptions.length);
  for (const row of [...guaranteed.rows, ...hourly.rows]) {
    assert.equal(deltaOptions.find(o => o.value === row.label).price, row.price);
  }
});

test("estimate: 特戰 牌位×陪陪牌位 equals calculateSelfServicePrice", async () => {
  const { response } = await estimate({ game: "特戰英豪", serviceType: "競技上分", targetRank: "白金", companionRank: "超凡", amount: 2, unit: "局", companionCount: 1 });
  const direct = pricing.calculateSelfServicePrice({ game: "valorant", serviceType: "白金", rankOrMap: "超凡", platformOrMode: "", quantity: 2, playerCount: 1 });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { amount: direct.total, unit: direct.unit, unitPrice: direct.unitPrice });
});

test("estimate: 特戰 app rank labels map onto bot aliases", async () => {
  const { response } = await estimate({ game: "特戰英豪", serviceType: "娛樂", targetRank: "銀牌", companionRank: "", amount: 3, unit: "小時", companionCount: 2 });
  const direct = pricing.calculateSelfServicePrice({ game: "valorant", serviceType: "黃金以下", rankOrMap: "娛樂", quantity: 3, playerCount: 2 });
  assert.deepEqual(response.json, { amount: direct.total, unit: direct.unit, unitPrice: direct.unitPrice });
  const silverCompanion = (await estimate({ game: "特戰英豪", serviceType: "競技上分", targetRank: "金牌", companionRank: "銀牌", amount: 1, unit: "小時", companionCount: 1 })).response.json;
  // 銀牌 companion resolves to the bot's 黃金含以下 level (not "unknown level"); the bot has no 黃金×黃金 price.
  assert.throws(() => pricing.calculateSelfServicePrice({ game: "valorant", serviceType: "黃金以下", rankOrMap: "黃金以下", quantity: 1, playerCount: 1 }), /目前價目表沒有這個特戰段位與陪陪等級組合/);
  assert.deepEqual(silverCompanion, { amount: null, reason: "目前價目表沒有這個特戰段位與陪陪等級組合" });
});

test("estimate: 三角洲保底 equals calculateSelfServicePrice", async () => {
  const option = pricing.getActiveDeltaServiceOptions().find(o => o.value.includes("保底"));
  const { response } = await estimate({ game: "三角洲行動", serviceType: option.value, targetRank: "", companionRank: "", amount: 1, unit: "局", companionCount: 2 });
  const direct = pricing.calculateSelfServicePrice({ game: "delta", platformOrMode: "電腦", serviceType: option.value, quantity: 1, playerCount: 2 });
  assert.deepEqual(response.json, { amount: direct.total, unit: direct.unit, unitPrice: direct.unitPrice });
});

test("estimate: Apex equals calculateSelfServicePrice", async () => {
  const { response } = await estimate({ game: "Apex 英雄", serviceType: "技術", targetRank: "鑽石", companionRank: "", amount: 2, unit: "小時", companionCount: 1 });
  const direct = pricing.calculateSelfServicePrice({ game: "apex", serviceType: "技術", rankOrMap: "鑽石", quantity: 2, playerCount: 1 });
  assert.deepEqual(response.json, { amount: direct.total, unit: direct.unit, unitPrice: direct.unitPrice });
  const goldApex = (await estimate({ game: "Apex 英雄", serviceType: "娛樂", targetRank: "金牌", amount: 1, unit: "小時", companionCount: 1 })).response.json;
  assert.equal(goldApex.amount, pricing.getActivePrices("apex").gold.entertain);
});

test("estimate: every price-table row round-trips through the estimate", async () => {
  const { response } = await call(bridge(), "GET", "/app/pricing", undefined);
  const lolGeneral = response.json.games.find(g => g.key === "lol").services.find(s => s.key === "entertain").rows.find(r => r.label === "一般");
  const lol = (await estimate({ game: "英雄聯盟", serviceType: "娛樂", targetRank: "一般", amount: 1, unit: lolGeneral.unit, companionCount: 1 })).response.json;
  assert.deepEqual(lol, { amount: lolGeneral.price, unit: lolGeneral.unit, unitPrice: lolGeneral.price });
  const tftRow = response.json.games.find(g => g.key === "tft").services.find(s => s.key === "skill").rows.find(r => r.label === "白金含以下");
  const tft = (await estimate({ game: "聯盟戰棋", serviceType: "技術", targetRank: "白金含以下", amount: 1, unit: "局", companionCount: 1 })).response.json;
  assert.equal(tft.amount, tftRow.price);
  const valorantGold = response.json.games.find(g => g.key === "valorant").services.find(s => s.key === "gold");
  const row = valorantGold.rows.find(r => r.label === "超凡");
  const valorant = (await estimate({ game: "特戰英豪", serviceType: "競技上分", targetRank: valorantGold.label, companionRank: row.label, amount: 1, unit: row.unit, companionCount: 1 })).response.json;
  assert.equal(valorant.amount, row.price);
});

test("estimate: unsupported combinations return amount null with the bot's Chinese reason", async () => {
  const cases = [
    [{ game: "傳說對決", serviceType: "娛樂", amount: 1, unit: "小時", companionCount: 1 }, "不支援的遊戲"],
    [{ game: "Apex 英雄", serviceType: "競技上分", targetRank: "鑽石", amount: 1, unit: "小時", companionCount: 1 }, "類型請填娛樂、技術或大神"],
    [{ game: "Apex 英雄", serviceType: "娛樂", targetRank: "", amount: 1, unit: "小時", companionCount: 1 }, "段位不在目前自動報價範圍內"],
    [{ game: "特戰英豪", serviceType: "競技上分", targetRank: "神話", companionRank: "輻能", amount: 1, unit: "局", companionCount: 1 }, "段位不在目前自動報價範圍內"],
    [{ game: "特戰英豪", serviceType: "競技上分", targetRank: "鑽石", companionRank: "白金", amount: 1, unit: "局", companionCount: 1 }, "需求的陪陪段位不可低於要打的段位"],
    [{ game: "三角洲行動", serviceType: "娛樂", amount: 1, unit: "小時", companionCount: 1 }, null],
  ];
  for (const [body, reason] of cases) {
    const { response } = await estimate(body);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.json.amount, null, JSON.stringify(body));
    assert.match(response.json.reason, /[一-鿿]/);
    if (reason) assert.equal(response.json.reason, reason);
  }
});

test("estimate: a unit the bot does not price in is not shown as a price", async () => {
  const { response } = await estimate({ game: "特戰英豪", serviceType: "競技上分", targetRank: "白金", companionRank: "超凡", amount: 2, unit: "小時", companionCount: 1 });
  assert.equal(response.json.amount, null);
  assert.match(response.json.reason, /局/);
});

test("estimate: invalid JSON and bad field types are 400; wrong method 405; unknown route 404", async () => {
  const body = "{not json";
  const request = fakeRequest("POST", "/app/pricing/estimate", body, sign("POST", "/app/pricing/estimate", body));
  const response = fakeResponse();
  await bridge().handleHttpRequest(request, response);
  assert.equal(response.status, 400);
  assert.equal((await estimate({ game: 5 })).response.status, 400);
  assert.equal((await call(bridge(), "GET", "/app/pricing/estimate", undefined)).response.status, 405);
  assert.equal((await call(bridge(), "GET", "/app/nothing", undefined)).response.status, 404);
});

// Fix round 1 (review I1–I3)
test("I1: 特戰 ranked estimate without a target rank is not priced as 黃金", async () => {
  for (const companionRank of ["超凡", "神話"]) {
    for (const targetRank of ["", undefined, "不限"]) {
      const { response } = await estimate({ game: "特戰英豪", serviceType: "競技上分", targetRank, companionRank, amount: 1, unit: "小時", companionCount: 1 });
      assert.deepEqual(response.json, { amount: null, reason: "請先選擇要打的段位" }, `${targetRank}/${companionRank}`);
    }
  }
});

test("I2: 特戰 娛樂 follows the bot's entertainment branch even when a companion rank is filled", async () => {
  const { response } = await estimate({ game: "特戰英豪", serviceType: "娛樂", targetRank: "鑽石", companionRank: "超凡", amount: 2, unit: "小時", companionCount: 1 });
  // Bot's own inputs for an NG / 娛樂 valorant order: target rank in serviceType, 娛樂 as the companion level.
  const direct = pricing.calculateSelfServicePrice({ game: "valorant", platformOrMode: "ng", serviceType: "鑽石", rankOrMap: "超凡", quantity: 2, playerCount: 1 });
  assert.equal(direct.unit, "小時");
  assert.deepEqual(response.json, { amount: direct.total, unit: direct.unit, unitPrice: direct.unitPrice });
});

test("I3: amount and companionCount must be integers 1–20, parsed strictly", async () => {
  const base = { game: "Apex 英雄", serviceType: "技術", targetRank: "鑽石", unit: "小時" };
  const bad = [
    { amount: -2, companionCount: 1 }, { amount: 0, companionCount: 1 }, { amount: "1e3", companionCount: 1 },
    { amount: 1.5, companionCount: 1 }, { amount: 21, companionCount: 1 }, { amount: "2小時", companionCount: 1 },
    { amount: 1, companionCount: -1 }, { amount: 1, companionCount: "2位" }, { amount: 1, companionCount: 0 },
    { amount: 1, companionCount: 21 }, { amount: 1, companionCount: 1.5 },
  ];
  for (const nums of bad) {
    const { response } = await estimate({ ...base, ...nums });
    assert.equal(response.json.amount, null, JSON.stringify(nums));
    assert.match(response.json.reason, /[\u4e00-\u9fff]/);
  }
  const ok = (await estimate({ ...base, amount: "3", companionCount: "2" })).response.json;
  const direct = pricing.calculateSelfServicePrice({ game: "apex", serviceType: "技術", rankOrMap: "鑽石", quantity: 3, playerCount: 2 });
  assert.equal(ok.amount, direct.total);
});
