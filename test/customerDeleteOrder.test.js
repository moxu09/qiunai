const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const { createAppOrderDelete } = require("../utils/appOrderDelete");
const { createAppInteractions } = require("../utils/appInteractions");
const dispatchSystem = require("../events/dispatchSystem");

const TOKEN = "test-bot-token";
const OWNER = "123456789012345678";
const OTHER = "223456789012345678";
const COMPANION = "323456789012345678";
const ORDER_ID = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";
const ORDER_NO = "QN-20261126-007";
const ORDER_CHANNEL = "300000000000000001";
const ROUTE = "/app/orders/delete";

// ---------- fakes ----------
function fakeDb({ orders, slips = {} }) {
  const updates = [];
  const reads = [];
  const tables = { play_orders: orders, ecpay_service_payments: slips.ecpay || [], jkopay_service_payments: slips.jkopay || [] };
  return {
    orders, updates, reads, failSlips: false,
    async rpc() { return { data: null, error: null }; },
    from(table) {
      const db = this;
      const filters = [];
      let patch = null;
      const rows = () => tables[table] || [];
      const matching = () => rows().filter((row) => filters.every((f) => f(row)));
      const query = {
        select() { return query; },
        update(value) { patch = value; return query; },
        eq(key, value) { filters.push((row) => String(row[key]) === String(value)); return query; },
        in(key, values) { filters.push((row) => values.map(String).includes(String(row[key]))); return query; },
        contains(key, value) {
          filters.push((row) => (value.orderIds || []).every((id) => (row[key]?.orderIds || []).includes(id)));
          return query;
        },
        is() { return query; }, or() { return query; }, gt() { return query; },
        limit() { return query; },
        async maybeSingle() {
          reads.push(table);
          const hit = matching()[0] || null;
          if (patch) {
            if (!hit) return { data: null, error: null };
            Object.assign(hit, patch);
            updates.push({ table, patch });
            return { data: { ...hit }, error: null };
          }
          return { data: hit ? { ...hit } : null, error: null };
        },
        async single() { return query.maybeSingle(); },
        then(resolve, reject) {
          if (table !== "play_orders" && db.failSlips) return Promise.resolve({ data: null, error: new Error("db down") }).then(resolve, reject);
          if (patch) {
            const hits = matching();
            hits.forEach((hit) => Object.assign(hit, patch));
            if (hits.length) updates.push({ table, patch });
            return Promise.resolve({ data: hits, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: matching().map((row) => ({ ...row })), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

class Collection extends Map {
  find(fn) { for (const value of this.values()) if (fn(value)) return value; return undefined; }
  some(fn) { return Boolean(this.find(fn)); }
}

function fakeClient({ topic = `owner:${OWNER};website_request:req-1`, withThread = false } = {}) {
  const log = { orderSends: [], threadSends: [], deleted: [], claimEdits: [], renamed: [], archived: [], requirementEdits: [] };
  const requirement = {
    id: "500000000000000001",
    author: { id: "999999999999999999" },
    components: [{ components: [{ customId: `website_order_delete_${ORDER_ID}`, type: 2 }] }],
    async edit(payload) { log.requirementEdits.push(payload); this.components = payload.components; return this; },
  };
  const orderChannel = {
    id: ORDER_CHANNEL, topic,
    isTextBased: () => true,
    messages: { async fetch() { return new Collection([[requirement.id, requirement]]); } },
    async send(payload) { log.orderSends.push(payload); return { id: "1" }; },
    async delete(reason) { log.deleted.push(reason); },
  };
  const thread = {
    id: "700000000000000001",
    name: `派單中-${ORDER_NO}-${ORDER_ID}`,
    archived: false,
    isThread: () => true,
    isTextBased: () => true,
    async send(payload) { log.threadSends.push(payload); return { id: "2" }; },
    async setName(name) { log.renamed.push(name); this.name = name; return this; },
    async setArchived(value) { log.archived.push(value); this.archived = value; return this; },
  };
  const claimMessage = {
    id: "710000000000000001",
    channel: thread,
    channelId: thread.id,
    content: "請在這個討論串內選擇要接的訂單",
    components: [],
    embeds: [{ description: `訂單：${ORDER_NO}\n遊戲：特戰英豪` }],
    async edit(payload) { log.claimEdits.push(payload); return this; },
  };
  thread.messages = { async fetch() { return new Collection([[claimMessage.id, claimMessage]]); } };
  const dispatchChannel = {
    id: "dispatch",
    isTextBased: () => true,
    messages: { async fetch() { return new Collection(); } },
    threads: {
      async fetchActive() { return { threads: new Collection(withThread ? [[thread.id, thread]] : []) }; },
      async fetchArchived() { return { threads: new Collection() }; },
    },
    async send() { return { id: "3" }; },
  };
  return {
    log, requirement,
    user: { id: "999999999999999999" },
    isReady: () => false,
    once() {},
    channels: { async fetch(id) { return id === ORDER_CHANNEL ? orderChannel : dispatchChannel; } },
    guilds: { cache: new Map(), async fetch() { return null; } },
  };
}

function websiteOrder(over = {}) {
  const now = new Date().toISOString();
  return {
    id: ORDER_ID, order_no: ORDER_NO, customer_id: OWNER, channel_id: ORDER_CHANNEL,
    service_flow_key: "website:req-1", status: "waiting_quote", quote_status: "waiting_quote",
    paid: false, paid_at: null, payment_method: "未選擇", player_count: 1, preferred_player: null,
    note: "APP 需求 req-1 [MANUAL_DISPATCH]", service: "特戰英豪｜技術", updated_at: now, created_at: now, ...over,
  };
}

function quiet(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(run).finally(() => Object.assign(console, original));
}

async function flush() { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); }

function setup(db, client) { dispatchSystem.setup(db, client, {}); }

// ---------- core ----------
for (const [status, quoteStatus] of [
  ["waiting_quote", "waiting_quote"],
  ["quoted", "quoted"],
  ["pending", "manual_dispatching"],
  ["pending", "manual_choosing_open"],
  ["pending", "manual_confirming_players"],
  ["quoted", "price_confirmed"],
]) {
  test(`core: owner deletes an unpaid website order in ${quoteStatus}`, (t) => quiet(async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const db = fakeDb({ orders: [websiteOrder({ status, quote_status: quoteStatus })] });
    const client = fakeClient();
    setup(db, client);
    const result = await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER);
    assert.deepEqual(result, { ok: true });
    assert.equal(db.orders[0].status, "cancelled");
    assert.equal(db.orders[0].quote_status, "cancelled");
    assert.equal(db.orders[0].paid, false);
    assert.equal(client.log.orderSends.at(-1).content, "客人已刪除這張需求單，頻道將於 10 秒後刪除。");
    assert.equal(client.log.deleted.length, 0);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(client.log.deleted.length, 1);
  }));
}

test("core: dispatch thread is closed like an abandoned dispatch and claimers are mentioned", (t) => quiet(async () => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = fakeDb({ orders: [websiteOrder({ status: "pending", quote_status: "manual_choosing_open", preferred_player: COMPANION })] });
  const client = fakeClient({ withThread: true });
  setup(db, client);
  assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true });
  assert.deepEqual(client.log.claimEdits[0], { components: [] });
  assert.match(client.log.threadSends[0].content, new RegExp(`<@${COMPANION}>.*客人已取消訂單`));
  assert.deepEqual(client.log.threadSends[0].allowedMentions.users, [COMPANION]);
  assert.equal(client.log.renamed.at(-1), dispatchSystem.getDispatchResultThreadName(db.orders[0], false));
  assert.match(client.log.renamed.at(-1), /^訂單棄單-/);
  assert.deepEqual(client.log.archived, [true]);
}));

test("core: dispatch timer is cleared (timeout never fires on the deleted order)", (t) => quiet(async () => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const dispatchAt = new Date(Date.now() - 60_000).toISOString();
  const db = fakeDb({ orders: [websiteOrder({ status: "pending", quote_status: "manual_dispatching",
    note: `APP 需求 req-1 [MANUAL_DISPATCH] [DISPATCH_AT:${dispatchAt}]` })] });
  const client = fakeClient();
  setup(db, client);
  // 延長一次會排入選人逾時計時器。
  assert.equal((await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID })).ok, true);
  assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true });
  const readsAfterDelete = db.reads.length;
  t.mock.timers.tick(60 * 60_000);
  await flush();
  // 只有 10 秒後刪頻道，沒有逾時棄單去讀訂單。
  assert.equal(db.reads.length, readsAfterDelete);
  assert.equal(client.log.deleted.length, 1);
}));

test("core: idempotent — second call returns ok without repeating side effects", (t) => quiet(async () => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = fakeDb({ orders: [websiteOrder()] });
  const client = fakeClient();
  setup(db, client);
  assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true });
  const sends = client.log.orderSends.length;
  assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true, alreadyDeleted: true });
  assert.equal(client.log.orderSends.length, sends);
  assert.equal(db.updates.filter((u) => u.table === "play_orders").length, 1);
}));

test("core: refuses paid, payment slips, chosen payment method, later stages, non-owner, non-website", () => quiet(async () => {
  const cases = [
    [{ paid: true, status: "waiting_confirm", quote_status: "price_confirmed" }, {}, "paid"],
    [{ status: "waiting_payment", quote_status: "price_confirmed", payment_method: "綠界支付" },
      { ecpay: [{ id: 1, organization_code: "qiunai", payment_kind: "order", entity_key: ORDER_ID, status: "pending" }] }, "has_payment"],
    [{ status: "waiting_payment", quote_status: "waiting_payment" },
      { jkopay: [{ id: 2, organization_code: "qiunai", payment_kind: "order", entity_key: ORDER_ID, status: "processing" }] }, "has_payment"],
    [{ status: "waiting_payment", quote_status: "price_confirmed" },
      { ecpay: [{ id: 3, organization_code: "qiunai", payment_kind: "order", entity_key: "group-1", status: "pending", metadata: { orderIds: [ORDER_ID] } }] }, "has_payment"],
    [{ status: "waiting_payment", quote_status: "price_confirmed" },
      { ecpay: [{ id: 4, organization_code: "qiunai", payment_kind: "order", entity_key: ORDER_ID, status: "paid" }] }, "paid"],
    [{ status: "waiting_payment", quote_status: "price_confirmed", payment_method: "匯款" }, {}, "has_payment"],
    [{ status: "pending", quote_status: "dispatched" }, {}, "not_deletable"],
    [{ status: "accepted", quote_status: "price_confirmed" }, {}, "not_deletable"],
  ];
  for (const [over, slips, code] of cases) {
    const db = fakeDb({ orders: [websiteOrder(over)], slips });
    const client = fakeClient();
    setup(db, client);
    const result = await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER);
    assert.deepEqual(result, { ok: false, code }, JSON.stringify(over));
    assert.equal(db.updates.length, 0);
    assert.equal(client.log.orderSends.length, 0);
  }
  {
    const db = fakeDb({ orders: [websiteOrder()] });
    setup(db, fakeClient());
    assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OTHER), { ok: false, code: "not_owner" });
    // 客服可代刪
    assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OTHER, { actorIsStaff: true }), { ok: true });
  }
  {
    const db = fakeDb({ orders: [websiteOrder({ service_flow_key: "general_quote:abc" })] });
    setup(db, fakeClient());
    assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: false, code: "not_found" });
  }
  {
    const db = fakeDb({ orders: [] });
    setup(db, fakeClient());
    assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: false, code: "not_found" });
  }
  {
    // 已失效／取消的付款單不擋
    const db = fakeDb({ orders: [websiteOrder()], slips: { ecpay: [{ id: 5, organization_code: "qiunai", payment_kind: "order", entity_key: ORDER_ID, status: "failed" }] } });
    setup(db, fakeClient());
    assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true });
  }
  {
    // 查不到付款單資料時不刪（交給呼叫端回 unavailable）
    const db = fakeDb({ orders: [websiteOrder()] });
    db.failSlips = true;
    setup(db, fakeClient());
    await assert.rejects(dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER));
    assert.equal(db.orders[0].status, "waiting_quote");
  }
}));

test("core: a channel that is not a dedicated 官網／APP channel is never deleted", (t) => quiet(async () => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = fakeDb({ orders: [websiteOrder()] });
  const client = fakeClient({ topic: "VIP 包廂" });
  setup(db, client);
  assert.deepEqual(await dispatchSystem.customerDeleteUnpaidOrder(ORDER_ID, OWNER), { ok: true });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(client.log.deleted.length, 0);
}));

test("retireWebsiteOrderDeleteButton removes only the delete row", () => quiet(async () => {
  const db = fakeDb({ orders: [websiteOrder()] });
  const client = fakeClient();
  setup(db, client);
  await dispatchSystem.retireWebsiteOrderDeleteButton(db.orders[0]);
  assert.deepEqual(client.log.requirementEdits, [{ components: [] }]);
}));

test("APP core: owner check, orderNo lookup, website only", () => quiet(async () => {
  const db = fakeDb({ orders: [websiteOrder()] });
  setup(db, fakeClient());
  assert.deepEqual(await dispatchSystem.deleteWebsiteOrderForApp({ userId: OTHER, orderNo: ORDER_NO }), { ok: false, code: "not_owner" });
  assert.deepEqual(await dispatchSystem.deleteWebsiteOrderForApp({ userId: OWNER, orderNo: "nope" }), { ok: false, code: "not_found" });
  assert.deepEqual(await dispatchSystem.deleteWebsiteOrderForApp({ userId: OWNER, orderNo: ORDER_NO }), { ok: true });
  assert.deepEqual(await dispatchSystem.deleteWebsiteOrderForApp({ userId: OWNER, orderId: ORDER_ID }), { ok: true, alreadyDeleted: true });
}));

// ---------- Discord buttons ----------
function fakeInteraction(customId, userId = OWNER) {
  const replies = [];
  // 其他路由會問各種 isXxx()；按鈕以外一律回 false。
  return new Proxy({
    replies, customId, user: { id: userId }, member: { roles: { cache: new Map() } },
    deferred: false, replied: false,
    isButton: () => true, isChatInputCommand: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); return payload; },
  }, { get: (target, key) => (key in target ? target[key] : typeof key === "string" && /^is[A-Z]/.test(key) ? () => false : undefined) });
}

test("Discord: 按錯了 asks 確定刪除 (no change), confirm deletes", (t) => quiet(async () => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = fakeDb({ orders: [websiteOrder()] });
  const client = fakeClient();
  setup(db, client);
  const first = fakeInteraction(`website_order_delete_${ORDER_ID}`);
  await dispatchSystem.handleDispatchInteraction(first);
  assert.match(first.replies[0].content, /確定刪除/);
  const confirmId = first.replies[0].components[0].components[0].data.custom_id;
  assert.equal(confirmId, `website_order_delete_confirm_${ORDER_ID}`);
  assert.equal(db.updates.length, 0);
  const stranger = fakeInteraction(confirmId, OTHER);
  await dispatchSystem.handleDispatchInteraction(stranger);
  assert.match(stranger.replies[0].content, /只有下單者本人/);
  assert.equal(db.orders[0].status, "waiting_quote");
  const confirm = fakeInteraction(confirmId);
  await dispatchSystem.handleDispatchInteraction(confirm);
  assert.match(confirm.replies[0].content, /已刪除這張需求單/);
  assert.equal(db.orders[0].status, "cancelled");
}));

test("Discord: once paid, 按錯了 explains and removes the button", () => quiet(async () => {
  const db = fakeDb({ orders: [websiteOrder({ paid: true, status: "waiting_confirm", quote_status: "price_confirmed" })] });
  const client = fakeClient();
  setup(db, client);
  const press = fakeInteraction(`website_order_delete_${ORDER_ID}`);
  await dispatchSystem.handleDispatchInteraction(press);
  assert.match(press.replies[0].content, /已經付款/);
  assert.deepEqual(client.log.requirementEdits, [{ components: [] }]);
}));

test("APP allowlist covers both delete buttons", () => {
  const interactions = createAppInteractions({ getClient: () => null, db: null, guildId: "1", route: async () => {} });
  const ids = interactions.allowlist().entries.map((item) => item.id);
  assert.ok(ids.includes("website_order_delete_"));
  assert.ok(ids.includes("website_order_delete_confirm_"));
});

// ---------- bridge ----------
function sign(method, url, body, time = String(Date.now())) {
  const signature = createHmac("sha256", TOKEN).update(`qiunai-website-v1\n${time}\n${method}\n${url}\n${body}`).digest("hex");
  return { "x-website-time": time, "x-website-signature": signature };
}

async function call(bridge, method, url, data, { signed = true } = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  const request = { method, url, headers: signed ? sign(method, url, body) : {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  const response = { status: null, text: "", writeHead(status) { this.status = status; }, end(text) { this.text = text || ""; }, get json() { return JSON.parse(this.text); } };
  await bridge.handleHttpRequest(request, response);
  return response;
}

test("bridge /app/orders/delete: signed, POST, validation, stable codes", async () => {
  const errors = dispatchSystem.CUSTOMER_DELETE_ERRORS;
  const seen = [];
  const results = [];
  const orderDelete = createAppOrderDelete({ remove: async (input) => { seen.push(input); return results.shift(); }, errors });
  const bridge = createAppBridge({ token: TOKEN, orderDelete });
  assert.equal((await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID }, { signed: false })).status, 401);
  assert.equal((await call(bridge, "GET", ROUTE)).status, 405);
  const none = await call(createAppBridge({ token: TOKEN }), "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
  assert.equal(none.status, 503);
  assert.equal(none.json.code, "unavailable");
  for (const bad of [{}, { userId: "x", orderId: ORDER_ID }, { userId: OWNER, orderId: "nope" }, { userId: OWNER, orderNo: "a b" }]) {
    const r = await call(bridge, "POST", ROUTE, bad);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "invalid_request");
  }
  assert.equal(seen.length, 0);
  results.push({ ok: true });
  assert.deepEqual((await call(bridge, "POST", ROUTE, { userId: OWNER, orderNo: ORDER_NO })).json, { ok: true });
  assert.deepEqual(seen.pop(), { userId: OWNER, orderNo: ORDER_NO });
  results.push({ ok: true, alreadyDeleted: true });
  assert.deepEqual((await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID })).json, { ok: true, alreadyDeleted: true });
  const expected = { not_found: 404, not_owner: 403, paid: 409, has_payment: 409, not_deletable: 409, unavailable: 503 };
  for (const [code, status] of Object.entries(expected)) {
    results.push({ ok: false, code });
    const r = await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
    assert.equal(r.status, status, code);
    assert.deepEqual([r.json.ok, r.json.code], [false, code]);
    assert.match(r.json.error, /[一-鿿]/);
  }
  results.push({ ok: false, code: "weird" });
  assert.equal((await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID })).json.code, "unavailable");
  const throwing = createAppBridge({ token: TOKEN, orderDelete: createAppOrderDelete({ remove: async () => { throw new Error("db"); }, errors }) });
  const thrown = await call(throwing, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
  assert.equal(thrown.status, 503);
  assert.equal(thrown.json.code, "unavailable");
  assert.match(errors.has_payment.message, /這張訂單已經開了付款單，請先到付款畫面取消那筆付款，或聯絡客服/);
});
