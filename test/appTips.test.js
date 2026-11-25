const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const { createAppTips, TIP_ORDER_PANEL_CHANNEL_ID } = require("../utils/appTips");

const TOKEN = "test-bot-token";
const GUILD = "1206138511535898654";
const USER = "123456789012345678";
const STAFF_A = "223456789012345678";
const STAFF_B = "323456789012345678";
const REQ = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";

function sign(method, url, body, time = String(Date.now()), token = TOKEN) {
  const signature = createHmac("sha256", token)
    .update(`qiunai-website-v1\n${time}\n${method}\n${url}\n${body}`)
    .digest("hex");
  return { "x-website-time": time, "x-website-signature": signature };
}

async function call(bridge, method, url, data, { signed = true } = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  const request = {
    method, url, headers: signed ? sign(method, url, body) : {},
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); },
  };
  const response = {
    status: null, text: "",
    writeHead(status) { this.status = status; },
    end(text) { this.text = text || ""; },
    get json() { return JSON.parse(this.text); },
  };
  await bridge.handleHttpRequest(request, response);
  return response;
}

function setup(overrides = {}) {
  const calls = { pay: [], vip: [], reports: [], broadcasts: [] };
  const staff = [
    { discord_id: STAFF_A, display_name: "小A", is_active: true },
    { discord_id: STAFF_B, display_name: "小B", is_active: true },
    { discord_id: "423456789012345678", display_name: "離職", is_active: false },
    { discord_id: null, display_name: "無ID", is_active: true },
    { discord_id: USER, display_name: "客人自己也是陪陪", is_active: true },
  ];
  let orderNo = 0;
  const deps = {
    guildId: GUILD,
    listActiveStaff: async () => staff,
    payTipAllocations: async (args) => {
      calls.pay.push(args);
      return {
        balance: 500,
        orders: args.allocations.map(a => ({ id: `o${++orderNo}`, assigned_player: a.staffId, customer_id: args.tipperId, final_price: a.amount })),
      };
    },
    countOrderVipSpentOnce: async (order, reason) => { calls.vip.push({ order, reason }); },
    sendTipWorkReports: async (orders, payload) => { calls.reports.push({ orders, payload }); },
    sendTipBroadcast: async (tipData) => { calls.broadcasts.push(tipData); },
    logger: { error() {}, warn() {}, log() {} },
    ...overrides,
  };
  const tips = createAppTips(deps);
  return { calls, tips, bridge: createAppBridge({ token: TOKEN, tips }) };
}

const goodBody = (extra = {}) => ({
  userId: USER,
  requestId: REQ,
  allocations: [
    { staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 2 }] },
    { staffId: STAFF_B, lines: [{ key: "tip_100_salty_chicken", quantity: 1 }] },
  ],
  broadcast: { enabled: true, anonymous: false },
  source: "standalone",
  ...extra,
});

test("TIP_ORDER_PANEL_CHANNEL_ID matches dispatchSystem", () => {
  const source = fs.readFileSync(path.join(__dirname, "../events/dispatchSystem.js"), "utf8");
  const match = source.match(/const TIP_ORDER_PANEL_CHANNEL_ID = "(\d+)"/);
  assert.equal(TIP_ORDER_PANEL_CHANNEL_ID, match[1]);
});

test("unsigned tip requests get 401 and never pay", async () => {
  const { bridge, calls } = setup();
  assert.equal((await call(bridge, "GET", `/app/tips/catalog?guildId=${GUILD}`, undefined, { signed: false })).status, 401);
  assert.equal((await call(bridge, "POST", "/app/tips", goodBody(), { signed: false })).status, 401);
  assert.equal(calls.pay.length, 0);
});

test("bridge without tips module answers 503 in Chinese", async () => {
  const response = await call(createAppBridge({ token: TOKEN }), "POST", "/app/tips", goodBody());
  assert.equal(response.status, 503);
  assert.match(response.json.error, /打賞/);
});

test("catalog excludes tip_custom and lists only active staff with a discord id", async () => {
  const { bridge } = setup();
  const response = await call(bridge, "GET", `/app/tips/catalog?guildId=${GUILD}`);
  assert.equal(response.status, 200);
  const { gifts, staff, discordTipUrl } = response.json;
  assert.equal(gifts.length, 19);
  assert.ok(!gifts.some(g => g.key === "tip_custom"));
  assert.deepEqual(gifts[0], { key: "tip_33_bear_cookie", name: "小熊棉花糖餅乾", price: 33 });
  assert.deepEqual(staff.map(s => s.discordId), [STAFF_A, STAFF_B, USER]);
  assert.deepEqual(staff[0], { discordId: STAFF_A, name: "小A" });
  assert.equal(discordTipUrl, `https://discord.com/channels/${GUILD}/${TIP_ORDER_PANEL_CHANNEL_ID}`);
});

test("catalog rejects a different guild and wrong methods", async () => {
  const { bridge } = setup();
  assert.equal((await call(bridge, "GET", "/app/tips/catalog?guildId=999999999999999999")).status, 400);
  assert.equal((await call(bridge, "POST", "/app/tips/catalog", {})).status, 405);
  assert.equal((await call(bridge, "GET", "/app/tips")).status, 405);
});

test("successful tip pays once via the wallet machinery and runs the Discord notifications", async () => {
  const { bridge, calls } = setup();
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    ok: true, total: 166, balance: 500,
    orders: [{ id: "o1", staffId: STAFF_A, amount: 66 }, { id: "o2", staffId: STAFF_B, amount: 100 }],
  });
  assert.equal(calls.pay.length, 1);
  const pay = calls.pay[0];
  assert.equal(pay.operationKey, `${GUILD}:app-tip:${REQ}`);
  assert.equal(pay.heartFlowId, null);
  assert.equal(pay.guildId, GUILD);
  assert.equal(pay.tipperId, USER);
  assert.equal(pay.channelId, TIP_ORDER_PANEL_CHANNEL_ID);
  assert.deepEqual(pay.allocations.map(a => [a.staffId, a.amount, a.item]), [
    [STAFF_A, 66, "小熊棉花糖餅乾×2"], [STAFF_B, 100, "鹹酥雞×1"],
  ]);
  // prices come from config, never from the client
  assert.equal(pay.allocations[0].lines[0].price, 33);
  assert.equal(calls.vip.length, 2);
  assert.match(calls.vip[0].reason, /錢包打賞付款完成/);
  assert.equal(calls.reports.length, 1);
  assert.deepEqual(calls.reports[0].payload, { tipperId: USER });
  assert.equal(calls.reports[0].orders.length, 2);
  assert.equal(calls.broadcasts.length, 1);
  const tipData = calls.broadcasts[0];
  assert.equal(tipData.tipperId, USER);
  assert.equal(tipData.broadcastEnabled, true);
  assert.equal(tipData.broadcastAnonymous, false);
  assert.equal(tipData.channelId, undefined, "no channelId: the receipt must not be posted anywhere");
  assert.equal(tipData.allocations.length, 2);
});

test("broadcast disabled skips the public broadcast but still sends VIP + work reports", async () => {
  const { bridge, calls } = setup();
  const response = await call(bridge, "POST", "/app/tips", goodBody({ broadcast: { enabled: false, anonymous: false } }));
  assert.equal(response.status, 200);
  assert.equal(calls.vip.length, 2);
  assert.equal(calls.reports.length, 1);
  assert.equal(calls.broadcasts.length, 0);
});

test("anonymous broadcast is passed through", async () => {
  const { bridge, calls } = setup();
  await call(bridge, "POST", "/app/tips", goodBody({ broadcast: { enabled: true, anonymous: true } }));
  assert.equal(calls.broadcasts[0].broadcastAnonymous, true);
});

test("same requestId twice pays once and does not re-notify", async () => {
  const { bridge, calls } = setup();
  const first = await call(bridge, "POST", "/app/tips", goodBody());
  const second = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, first.json);
  assert.equal(calls.pay.length, 1);
  assert.equal(calls.vip.length, 2);
  assert.equal(calls.reports.length, 1);
  assert.equal(calls.broadcasts.length, 1);
});

test("same requestId with a different body is rejected", async () => {
  const { bridge, calls } = setup();
  await call(bridge, "POST", "/app/tips", goodBody());
  const changed = goodBody();
  changed.allocations[0].lines[0].quantity = 3;
  const response = await call(bridge, "POST", "/app/tips", changed);
  assert.equal(response.status, 409);
  assert.equal(calls.pay.length, 1);
});

test("a concurrent duplicate gets 409 while the first is still paying", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { bridge, calls } = setup({
    payTipAllocations: async (args) => {
      calls.pay.push(args);
      await gate;
      return { balance: 1, orders: [] };
    },
  });
  const first = call(bridge, "POST", "/app/tips", goodBody());
  await new Promise(resolve => setImmediate(resolve));
  const second = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "這筆打賞正在處理中");
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls.pay.length, 1);
});

test("insufficient balance maps to 402 with numeric balance and need, and may be retried", async () => {
  let fail = true;
  const { bridge, calls } = setup({
    payTipAllocations: async (args) => {
      calls.pay.push(args);
      if (fail) throw Object.assign(new Error("餘額不足，目前餘額 120 ASD，需要 166 ASD"), { code: "P0001" });
      return { balance: 0, orders: [] };
    },
  });
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 402);
  assert.equal(response.json.balance, 120);
  assert.equal(response.json.need, 166);
  assert.match(response.json.error, /餘額不足/);
  assert.equal(calls.vip.length + calls.reports.length + calls.broadcasts.length, 0);
  fail = false;
  assert.equal((await call(bridge, "POST", "/app/tips", goodBody())).status, 200);
  assert.equal(calls.pay.length, 2);
});

test("unknown RPC errors map to 503 without leaking details", async () => {
  const { bridge, calls } = setup({
    payTipAllocations: async () => { throw new Error("connection terminated unexpectedly"); },
  });
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 503);
  assert.equal(response.json.error, "打賞暫時無法完成，請稍後再試");
  assert.equal(calls.vip.length, 0);
});

test("a known Chinese validation error from the pay function maps to 400", async () => {
  const { bridge } = setup({ payTipAllocations: async () => { throw new Error("不能打賞自己"); } });
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "不能打賞自己");
});

test("notification failures after payment still return success", async () => {
  const { bridge } = setup({
    countOrderVipSpentOnce: async () => { throw new Error("vip down"); },
    sendTipWorkReports: async () => { throw new Error("discord down"); },
    sendTipBroadcast: async () => { throw new Error("discord down"); },
  });
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
});

const invalidCases = [
  ["invalid JSON", "not json"],
  ["missing userId", goodBody({ userId: undefined })],
  ["short userId", goodBody({ userId: "1234" })],
  ["non-UUID requestId", goodBody({ requestId: "abc" })],
  ["no allocations", goodBody({ allocations: [] })],
  ["unknown gift", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_nope", quantity: 1 }] }] })],
  ["tip_custom", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_custom", quantity: 1 }] }] })],
  ["quantity 0", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 0 }] }] })],
  ["quantity 1000", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 1000 }] }] })],
  ["fractional quantity", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 1.5 }] }] })],
  ["string quantity", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: "2" }] }] })],
  ["no lines", goodBody({ allocations: [{ staffId: STAFF_A, lines: [] }] })],
  ["duplicate gift line", goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 1 }, { key: "tip_33_bear_cookie", quantity: 1 }] }] })],
  ["duplicate staff", goodBody({ allocations: [
    { staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] },
    { staffId: STAFF_A, lines: [{ key: "tip_60_sakura_charm", quantity: 1 }] },
  ] })],
  ["inactive staff", goodBody({ allocations: [{ staffId: "423456789012345678", lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] })],
  ["unknown staff", goodBody({ allocations: [{ staffId: "523456789012345678", lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] })],
  ["self tip", goodBody({ allocations: [{ staffId: USER, lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] })],
  ["bad source", goodBody({ source: "jkopay" })],
  ["bad broadcast", goodBody({ broadcast: { enabled: "yes", anonymous: false } })],
  ["missing broadcast", goodBody({ broadcast: undefined })],
  ["too long orderRef", goodBody({ orderRef: "x".repeat(101) })],
  ["other guild", goodBody({ guildId: "999999999999999999" })],
];

for (const [name, body] of invalidCases) {
  test(`validation: ${name} -> 400 in Chinese, no payment`, async () => {
    const { bridge, calls } = setup();
    const raw = typeof body === "string";
    const url = "/app/tips";
    const text = raw ? body : JSON.stringify(body);
    const request = {
      method: "POST", url, headers: sign("POST", url, text),
      async *[Symbol.asyncIterator]() { yield Buffer.from(text); },
    };
    const response = { status: null, text: "", writeHead(s) { this.status = s; }, end(t) { this.text = t; } };
    await bridge.handleHttpRequest(request, response);
    assert.equal(response.status, 400, name);
    assert.match(JSON.parse(response.text).error, /[一-鿿]/);
    assert.equal(calls.pay.length, 0);
  });
}

test("self tip message is explicit", async () => {
  const { bridge } = setup();
  const response = await call(bridge, "POST", "/app/tips", goodBody({ allocations: [{ staffId: USER, lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] }));
  assert.equal(response.json.error, "不能打賞自己");
});

test("optional orderRef and order sources are accepted", async () => {
  const { bridge } = setup();
  for (const [i, source] of ["order-form", "order"].entries()) {
    const response = await call(bridge, "POST", "/app/tips", goodBody({ source, orderRef: "QN-1", requestId: `8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5${i}` }));
    assert.equal(response.status, 200, source);
  }
});

test("completed map is bounded", async () => {
  const { tips } = setup({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) {
    const result = await tips.tip(goodBody({ requestId: `8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5${i}` }));
    assert.equal(result.status, 200);
  }
  assert.ok(tips.size() <= 3);
});
