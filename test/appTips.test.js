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
const OP = `${GUILD}:app-tip:${REQ}`;

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

// Fake DB: wallet balance + tip_payment_operations, shared across app-tips instances
// (an instance restart keeps the DB but loses the in-memory map).
function fakeDb(balance = 1000) {
  return { balance, operations: new Map(), rpcCalls: [], charged: 0, orderNo: 0, failNext: null, commitThenThrow: null };
}

// Mirrors index.js payTipAllocationsWithWalletAtomic + the RPC: group by item+amount in
// allocation order, one RPC per group keyed `${operationKey}:${i}`, stored result replayed.
function fakePay(db, calls) {
  return async (args) => {
    calls.pay.push(args);
    if (args.allocations.some(a => a.staffId === args.tipperId)) throw new Error("不能打賞自己");
    const groups = new Map();
    for (const a of args.allocations) {
      const key = `${a.item}\u0000${a.amount}`;
      const g = groups.get(key) || { item: a.item, amount: a.amount, staffIds: [] };
      g.staffIds.push(a.staffId);
      groups.set(key, g);
    }
    const orders = [];
    let balance = null;
    let index = 0;
    for (const group of groups.values()) {
      const operationKey = `${args.operationKey}:${index}`;
      if (args.beforeGroup) await args.beforeGroup({ index, operationKey, ...group });
      db.rpcCalls.push(operationKey);
      let payment;
      const stored = db.operations.get(operationKey);
      if (stored) payment = stored.result;
      else {
        if (db.failNext) { const error = db.failNext; db.failNext = null; throw error; }
        const need = group.amount * group.staffIds.length;
        if (db.balance < need) throw new Error(`餘額不足，目前餘額 ${db.balance} ASD，需要 ${need} ASD`);
        db.balance -= need;
        db.charged += need;
        payment = {
          balance: db.balance,
          orders: group.staffIds.map(staffId => ({ id: `o${++db.orderNo}`, assigned_player: staffId, customer_id: args.tipperId, order_item: group.item, final_price: group.amount })),
        };
        db.operations.set(operationKey, { user_id: args.tipperId, result: payment });
        if (db.commitThenThrow) { const error = db.commitThenThrow; db.commitThenThrow = null; throw error; }
      }
      orders.push(...payment.orders);
      balance = payment.balance;
      if (args.afterGroup) await args.afterGroup({ index, operationKey, ...group, payment });
      index += 1;
    }
    return { balance, orders };
  };
}

function setup(overrides = {}, db = fakeDb()) {
  const calls = { pay: [], vip: [], reports: [], broadcasts: [], lookups: [] };
  const staff = [
    { discord_id: STAFF_A, display_name: "小A", real_name: "王小明", is_active: true },
    { discord_id: STAFF_B, display_name: "小B", is_active: true },
    { discord_id: "423456789012345678", display_name: "離職", is_active: false },
    { discord_id: null, display_name: "無ID", is_active: true },
    { discord_id: "623456789012345678", display_name: null, real_name: "陳真名", name: "陳真名", is_active: true },
    { discord_id: USER, display_name: "客人自己也是陪陪", is_active: true },
  ];
  const deps = {
    guildId: GUILD,
    listActiveStaff: async () => staff,
    payTipAllocations: fakePay(db, calls),
    lookupTipOperation: async (key) => { calls.lookups.push(key); return db.operations.get(key) || null; },
    countOrderVipSpentOnce: async (order, reason) => { calls.vip.push({ order, reason }); },
    sendTipWorkReports: async (orders, payload) => { calls.reports.push({ orders, payload }); },
    sendTipBroadcast: async (tipData) => { calls.broadcasts.push(tipData); },
    logger: { error() {}, warn() {}, log() {} },
    ...overrides,
  };
  const tips = createAppTips(deps);
  return { calls, tips, db, bridge: createAppBridge({ token: TOKEN, tips }) };
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

async function post(ctx, body = goodBody()) {
  const response = await call(ctx.bridge, "POST", "/app/tips", body);
  await ctx.tips.idle();
  return response;
}

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

test("catalog excludes tip_custom and lists only active staff with a discord id and public name", async () => {
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

test("I2: real names never reach the app; staff without a public name are omitted and cannot be tipped", async () => {
  const ctx = setup();
  const catalog = await call(ctx.bridge, "GET", "/app/tips/catalog");
  assert.ok(!catalog.text.includes("王小明"));
  assert.ok(!catalog.text.includes("陳真名"));
  assert.ok(!catalog.text.includes("623456789012345678"));
  const response = await post(ctx, goodBody({ allocations: [{ staffId: "623456789012345678", lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] }));
  assert.equal(response.status, 400);
  assert.equal(ctx.calls.pay.length, 0);
});

test("catalog rejects a different guild and wrong methods", async () => {
  const { bridge } = setup();
  assert.equal((await call(bridge, "GET", "/app/tips/catalog?guildId=999999999999999999")).status, 400);
  assert.equal((await call(bridge, "POST", "/app/tips/catalog", {})).status, 405);
  assert.equal((await call(bridge, "GET", "/app/tips")).status, 405);
});

test("successful tip pays via the wallet machinery and runs the Discord notifications", async () => {
  const ctx = setup();
  const { calls } = ctx;
  const response = await post(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    ok: true, total: 166, balance: 834,
    orders: [{ id: "o1", staffId: STAFF_A, amount: 66 }, { id: "o2", staffId: STAFF_B, amount: 100 }],
  });
  assert.equal(calls.pay.length, 1);
  const pay = calls.pay[0];
  assert.equal(pay.operationKey, OP);
  assert.equal(pay.heartFlowId, null);
  assert.equal(pay.guildId, GUILD);
  assert.equal(pay.tipperId, USER);
  assert.equal(pay.channelId, TIP_ORDER_PANEL_CHANNEL_ID);
  assert.deepEqual(pay.allocations.map(a => [a.staffId, a.amount, a.item]), [
    [STAFF_A, 66, "小熊棉花糖餅乾×2"], [STAFF_B, 100, "鹹酥雞×1"],
  ]);
  assert.equal(pay.allocations[0].lines[0].price, 33, "prices come from config");
  assert.deepEqual(calls.lookups, [`${OP}:0`, `${OP}:1`], "tip_payment_operations read before each group");
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

test("C1a: group keys are deterministic for a basket regardless of the order the app sends it", async () => {
  const one = setup();
  await post(one);
  const two = setup();
  const reversed = goodBody();
  reversed.allocations.reverse();
  await post(two, reversed);
  assert.deepEqual(two.db.rpcCalls, one.db.rpcCalls);
  assert.deepEqual(two.calls.pay[0].allocations.map(a => a.item), one.calls.pay[0].allocations.map(a => a.item));
  const lines = setup();
  await post(lines, goodBody({ allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_99_fireworks", quantity: 1 }, { key: "tip_33_bear_cookie", quantity: 1 }] }] }));
  assert.equal(lines.calls.pay[0].allocations[0].item, "小熊棉花糖餅乾×1、煙花×1");
});

test("I1: the response does not wait for notifications; they still run exactly once", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup({
    sendTipWorkReports: async (orders, payload) => { await gate; ctx.calls.reports.push({ orders, payload }); },
  });
  const response = await call(ctx.bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 200, "answered while work reports are still blocked");
  assert.equal(ctx.calls.reports.length, 0);
  const again = await call(ctx.bridge, "POST", "/app/tips", goodBody());
  assert.equal(again.status, 200);
  release();
  await ctx.tips.idle();
  assert.equal(ctx.calls.reports.length, 1);
  assert.equal(ctx.calls.vip.length, 2);
  assert.equal(ctx.calls.broadcasts.length, 1);
});

test("broadcast disabled skips the public broadcast but still sends VIP + work reports", async () => {
  const ctx = setup();
  const response = await post(ctx, goodBody({ broadcast: { enabled: false, anonymous: false } }));
  assert.equal(response.status, 200);
  assert.equal(ctx.calls.vip.length, 2);
  assert.equal(ctx.calls.reports.length, 1);
  assert.equal(ctx.calls.broadcasts.length, 0);
});

test("anonymous broadcast is passed through", async () => {
  const ctx = setup();
  await post(ctx, goodBody({ broadcast: { enabled: true, anonymous: true } }));
  assert.equal(ctx.calls.broadcasts[0].broadcastAnonymous, true);
});

test("same requestId twice pays once and does not re-notify", async () => {
  const ctx = setup();
  const first = await post(ctx);
  const second = await post(ctx);
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, first.json);
  assert.equal(ctx.calls.pay.length, 1);
  assert.equal(ctx.db.charged, 166);
  assert.equal(ctx.calls.vip.length, 2);
  assert.equal(ctx.calls.reports.length, 1);
  assert.equal(ctx.calls.broadcasts.length, 1);
});

test("C1b: same requestId with a different basket gets 409 and nothing is charged", async () => {
  const ctx = setup();
  await post(ctx);
  const changed = goodBody();
  changed.allocations[0].lines[0].quantity = 3;
  const response = await post(ctx, changed);
  assert.equal(response.status, 409);
  assert.equal(response.json.error, "這筆打賞內容已變更，請重新確認");
  assert.equal(ctx.calls.pay.length, 1);
  assert.equal(ctx.db.charged, 166);
});

test("I3: replay after a restart returns the stored result and sends no notifications", async () => {
  const db = fakeDb();
  const first = setup({}, db);
  const original = await post(first);
  const restarted = setup({}, db);
  const replay = await post(restarted);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, original.json);
  assert.equal(db.charged, 166);
  assert.equal(restarted.calls.vip.length + restarted.calls.reports.length + restarted.calls.broadcasts.length, 0);
});

test("C1b durable: after a restart a changed basket on a paid requestId gets 409 before any RPC", async () => {
  const db = fakeDb();
  await post(setup({}, db));
  const restarted = setup({}, db);
  const changed = goodBody();
  changed.allocations[0].lines[0].quantity = 5;
  const before = db.rpcCalls.length;
  const response = await post(restarted, changed);
  assert.equal(response.status, 409);
  assert.equal(response.json.error, "這筆打賞內容已變更，請重新確認");
  assert.equal(db.rpcCalls.length, before);
  assert.equal(db.charged, 166);
});

test("C1c/d: partial charge -> 502 partial; changed basket 409; identical retry completes the rest without double charge", async () => {
  const db = fakeDb(70);
  const ctx = setup({}, db);
  const first = await post(ctx);
  assert.equal(first.status, 502);
  assert.deepEqual(first.json, {
    error: "部分打賞已完成，請重試以完成其餘部分（不會重複扣款）",
    partial: true,
    paidStaffIds: [STAFF_A],
    balance: 4,
    need: 100,
  });
  assert.equal(db.charged, 66);
  // money moved for 小A: that group is notified (once)
  assert.equal(ctx.calls.vip.length, 1);
  assert.equal(ctx.calls.reports[0].orders.length, 1);
  assert.deepEqual(ctx.calls.broadcasts[0].allocations.map(a => a.staffId), [STAFF_A]);

  const edited = goodBody({ allocations: [goodBody().allocations[1]] });
  const conflict = await post(ctx, edited);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, "這筆打賞內容已變更，請重新確認");
  assert.equal(db.charged, 66);

  db.balance += 200; // top-up
  const retry = await post(ctx);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.total, 166);
  assert.equal(db.charged, 166, "小A's group replayed, not charged again");
  assert.equal(ctx.calls.vip.length, 2, "only the newly paid group is notified");
  assert.equal(ctx.calls.reports.length, 2);
  assert.deepEqual(ctx.calls.reports[1].orders.map(o => o.assigned_player), [STAFF_B]);
  assert.deepEqual(ctx.calls.broadcasts[1].allocations.map(a => a.staffId), [STAFF_B]);
});

test("a concurrent duplicate gets 409 while the first is still paying", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setup({
    lookupTipOperation: async () => { await gate; return null; },
  });
  const first = call(ctx.bridge, "POST", "/app/tips", goodBody());
  await new Promise(resolve => setImmediate(resolve));
  const second = await call(ctx.bridge, "POST", "/app/tips", goodBody());
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "這筆打賞正在處理中");
  release();
  assert.equal((await first).status, 200);
  assert.equal(ctx.calls.pay.length, 1);
});

test("insufficient balance on the first group -> 402 with numbers, nothing charged, retry allowed", async () => {
  const db = fakeDb(50);
  const ctx = setup({}, db);
  const response = await post(ctx);
  assert.equal(response.status, 402);
  assert.deepEqual(response.json, { error: "餘額不足，目前餘額 50 ASD，需要 66 ASD", balance: 50, need: 66 });
  assert.equal(ctx.calls.vip.length + ctx.calls.reports.length + ctx.calls.broadcasts.length, 0);
  db.balance = 500;
  assert.equal((await post(ctx)).status, 200);
  assert.equal(db.charged, 166);
});

test("I4: a network-style RPC error is 'uncertain', not 'try later'", async () => {
  const db = fakeDb();
  db.failNext = new Error("fetch failed");
  const ctx = setup({}, db);
  const response = await post(ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: "打賞結果確認中，請到錢包確認後用同一筆重試（不會重複扣款）", uncertain: true });
});

test("I4: RPC committed but the reply was lost -> uncertain; same-request retry completes and notifies once", async () => {
  const db = fakeDb();
  db.commitThenThrow = new Error("socket hang up");
  const ctx = setup({}, db);
  const first = await post(ctx);
  assert.equal(first.status, 503);
  assert.equal(first.json.uncertain, true);
  assert.equal(ctx.calls.vip.length, 0);
  const retry = await post(ctx);
  assert.equal(retry.status, 200);
  assert.equal(db.charged, 166);
  assert.equal(ctx.calls.vip.length, 2, "the group whose reply was lost is notified on the retry");
  assert.equal(ctx.calls.reports.length, 1);
  assert.equal(ctx.calls.broadcasts.length, 1);
});

test("I4: an error after a successful group is uncertain, not partial", async () => {
  const db = fakeDb();
  const ctx = setup({}, db);
  // after group 0 succeeds, group 1's RPC fails with a non-Chinese (possibly committed) error
  const pay = fakePay(db, ctx.calls);
  const tips = createAppTips({
    guildId: GUILD,
    listActiveStaff: async () => [{ discord_id: STAFF_A, display_name: "小A" }, { discord_id: STAFF_B, display_name: "小B" }],
    payTipAllocations: async (args) => pay({ ...args, afterGroup: async (g) => { await args.afterGroup(g); db.failNext = new Error("ETIMEDOUT"); } }),
    lookupTipOperation: async key => db.operations.get(key) || null,
    countOrderVipSpentOnce: async (order, reason) => { ctx.calls.vip.push({ order, reason }); },
    sendTipWorkReports: async () => {},
    sendTipBroadcast: async () => {},
    logger: { error() {} },
  });
  const result = await tips.tip(goodBody());
  await tips.idle();
  assert.equal(result.status, 503);
  assert.equal(result.body.uncertain, true);
  assert.equal(ctx.calls.vip.length, 1, "the group that did succeed is still notified");
});

test("unknown Chinese RPC error on the first group (rolled back) keeps the generic 503", async () => {
  const db = fakeDb();
  db.failNext = new Error("陪陪資料不完整");
  const ctx = setup({}, db);
  const response = await post(ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: "打賞暫時無法完成，請稍後再試" });
});

test("tip_payment_operations read failure before the first group -> nothing charged, generic 503", async () => {
  const ctx = setup({ lookupTipOperation: async () => { throw new Error("db down"); } });
  const response = await post(ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: "打賞暫時無法完成，請稍後再試" });
  assert.equal(ctx.db.charged, 0);
});

test("a known Chinese validation error from the pay function maps to 400", async () => {
  const ctx = setup({ payTipAllocations: async () => { throw new Error("不能打賞自己"); } });
  const response = await post(ctx);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "不能打賞自己");
});

test("notification failures after payment still return success", async () => {
  const ctx = setup({
    countOrderVipSpentOnce: async () => { throw new Error("vip down"); },
    sendTipWorkReports: async () => { throw new Error("discord down"); },
    sendTipBroadcast: async () => { throw new Error("discord down"); },
  });
  const response = await post(ctx);
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

// ---- final review fixes (I1, M1) ----
const UNCERTAIN_BODY = { error: "打賞結果確認中，請到錢包確認後用同一筆重試（不會重複扣款）", uncertain: true };

test("final I1a: an unexpected throw from tips.tip is answered by the bridge as uncertain, not 'nothing charged'", async () => {
  const bridge = createAppBridge({
    token: TOKEN,
    tips: { catalog: async () => ({ status: 200, body: {} }), tip: async () => { throw new TypeError("Cannot read properties of null (reading 'id')"); } },
  });
  const response = await call(bridge, "POST", "/app/tips", goodBody());
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, UNCERTAIN_BODY);
});

test("final I1b: an unexpected throw after the charge resolves as uncertain, notifies once, and the retry is not stuck on 409", async () => {
  const db = fakeDb();
  const calls = { pay: [] };
  const pay = fakePay(db, calls);
  let breakReply = true;
  const ctx = setup({
    payTipAllocations: async (args) => {
      const result = await pay(args);
      if (!breakReply) return result;
      breakReply = false;
      return { balance: result.balance, get orders() { throw new TypeError("boom after charge"); } };
    },
  }, db);
  const first = await post(ctx);
  assert.equal(first.status, 503);
  assert.deepEqual(first.json, UNCERTAIN_BODY);
  assert.equal(db.charged, 166);
  assert.equal(ctx.calls.vip.length, 2, "the charged groups are still notified");
  assert.equal(ctx.calls.reports.length, 1);
  const retry = await post(ctx);
  assert.equal(retry.status, 200, "same requestId retry is not stuck on 409");
  assert.equal(db.charged, 166, "no double charge");
  assert.equal(ctx.calls.vip.length, 2, "no duplicate notifications");
});

test("final I1b: a null order in the payment result does not throw; the answer is 200 and replays", async () => {
  const db = fakeDb();
  const calls = { pay: [] };
  const pay = fakePay(db, calls);
  const ctx = setup({
    payTipAllocations: async (args) => {
      const result = await pay(args);
      return { balance: result.balance, orders: [null, ...result.orders] };
    },
  }, db);
  const first = await post(ctx);
  assert.equal(first.status, 200);
  assert.equal(first.json.orders.length, 2);
  const again = await post(ctx);
  assert.equal(again.status, 200);
  assert.equal(db.charged, 166);
});

test("final I1c: a pending request older than 2 minutes expires so the same requestId can run again", async () => {
  let clock = 1_000_000;
  let hang = true;
  const db = fakeDb();
  const ctx = setup({
    now: () => clock,
    lookupTipOperation: async (key) => {
      if (hang) { hang = false; return new Promise(() => {}); }
      return db.operations.get(key) || null;
    },
  }, db);
  call(ctx.bridge, "POST", "/app/tips", goodBody()); // hangs forever
  await new Promise(resolve => setImmediate(resolve));
  clock += 60 * 1000;
  const early = await call(ctx.bridge, "POST", "/app/tips", goodBody());
  assert.equal(early.status, 409);
  assert.equal(early.json.error, "這筆打賞正在處理中");
  clock += 61 * 1000;
  const late = await post(ctx);
  assert.equal(late.status, 200);
  assert.equal(db.charged, 166);
  const changed = await call(ctx.bridge, "POST", "/app/tips", goodBody({ broadcast: { enabled: false, anonymous: false }, allocations: [{ staffId: STAFF_A, lines: [{ key: "tip_33_bear_cookie", quantity: 1 }] }] }));
  assert.equal(changed.status, 409, "fingerprint is kept");
});

test("final M1: an empty staff list (DB read error) is 503 unavailable, not a definite 400; catalog too", async () => {
  const ctx = setup({ listActiveStaff: async () => [] });
  const response = await post(ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: "打賞暫時無法完成，請稍後再試" });
  assert.equal(ctx.calls.pay.length, 0);
  const catalog = await call(ctx.bridge, "GET", `/app/tips/catalog?guildId=${GUILD}`);
  assert.equal(catalog.status, 503);
  assert.match(catalog.json.error, /打賞暫時無法完成/);
});

test("final M1: a staff-list failure on a retry after a possible charge is uncertain, not 'nothing charged'", async () => {
  for (const broken of [async () => [], async () => { throw new Error("db down"); }]) {
    const db = fakeDb();
    db.commitThenThrow = new Error("socket hang up");
    let list = null;
    const staffCtx = setup({ listActiveStaff: async () => (list ? list() : [{ discord_id: STAFF_A, display_name: "小A" }, { discord_id: STAFF_B, display_name: "小B" }]) }, db);
    const first = await post(staffCtx);
    assert.equal(first.status, 503);
    assert.equal(first.json.uncertain, true);
    list = broken;
    const retry = await post(staffCtx);
    assert.equal(retry.status, 503);
    assert.deepEqual(retry.json, UNCERTAIN_BODY);
    assert.equal(db.charged, 66);
  }
});
