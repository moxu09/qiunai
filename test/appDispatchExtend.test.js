const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { createAppBridge } = require("../utils/appBridge");
const { createAppDispatchExtend } = require("../utils/appDispatchExtend");
const dispatchSystem = require("../events/dispatchSystem");

const TOKEN = "test-bot-token";
const OWNER = "123456789012345678";
const OTHER = "223456789012345678";
const ORDER_ID = "8f14e45f-ceea-4b67-8a2c-4f1b2a3c4d5e";
const ORDER_CHANNEL = "300000000000000001";
const ROUTE = "/app/orders/extend-dispatch";

function sign(method, url, body, time = String(Date.now())) {
  const signature = createHmac("sha256", TOKEN)
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

const errors = dispatchSystem.DISPATCH_EXTEND_ERRORS;

test("bridge route: signed only, POST only, 503 without the service, bad JSON 400", async () => {
  const dispatch = createAppDispatchExtend({ extend: async () => ({ ok: true, deadlineAt: Date.now() }), errors });
  const bridge = createAppBridge({ token: TOKEN, dispatch });
  assert.equal((await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID }, { signed: false })).status, 401);
  assert.equal((await call(bridge, "GET", ROUTE, undefined)).status, 405);
  const none = await call(createAppBridge({ token: TOKEN }), "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
  assert.equal(none.status, 503);
  assert.equal(none.json.code, "unavailable");
  assert.match(none.json.error, /[一-鿿]/);
});

test("extendDispatch validates input and maps codes to stable status + 繁體中文", async () => {
  const seen = [];
  const results = [];
  const dispatch = createAppDispatchExtend({ extend: async (input) => { seen.push(input); return results.shift(); }, errors });
  const bridge = createAppBridge({ token: TOKEN, dispatch });

  for (const bad of [{}, { userId: "x", orderId: ORDER_ID }, { userId: OWNER, orderId: "nope" }, { userId: OWNER, orderNo: "a b" }, null]) {
    const r = await call(bridge, "POST", ROUTE, bad);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "invalid_request");
  }
  assert.equal(seen.length, 0);

  const deadlineAt = Date.parse("2026-11-26T12:20:00.000Z");
  results.push({ ok: true, deadlineAt });
  const ok = await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, deadlineAt: "2026-11-26T12:20:00.000Z" });
  assert.deepEqual(seen.pop(), { userId: OWNER, orderId: ORDER_ID });

  results.push({ ok: true, deadlineAt });
  await call(bridge, "POST", ROUTE, { userId: OWNER, orderNo: "QN-20261126-001" });
  assert.deepEqual(seen.pop(), { userId: OWNER, orderNo: "QN-20261126-001" });

  const expected = {
    not_found: 404, no_deadline: 409, not_owner: 403, not_dispatching: 409,
    already_extended: 409, in_progress: 409, expired: 409, stale: 409,
  };
  for (const [code, status] of Object.entries(expected)) {
    results.push({ ok: false, code });
    const r = await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
    assert.equal(r.status, status, code);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, code);
    assert.match(r.json.error, /[一-鿿]/);
  }
  results.push({ ok: false, code: "weird" });
  assert.equal((await call(bridge, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID })).status, 503);
  const throwing = createAppBridge({ token: TOKEN, dispatch: createAppDispatchExtend({ extend: async () => { throw new Error("db"); }, errors }) });
  const thrown = await call(throwing, "POST", ROUTE, { userId: OWNER, orderId: ORDER_ID });
  assert.equal(thrown.status, 503);
  assert.equal(thrown.json.code, "unavailable");
});

// ---------- shared core (extendDispatchForApp) against a fake Supabase + Discord client ----------

function fakeDb(rows) {
  const updates = [];
  return {
    rows, updates,
    async rpc() { return { data: null, error: null }; },
    from(table) {
      const filters = [];
      let patch = null;
      const matching = () => (table === "play_orders" ? rows : []).filter((row) =>
        filters.every(([key, value]) => String(row[key]) === String(value)));
      const query = {
        select() { return query; },
        update(value) { patch = value; return query; },
        insert() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in() { return query; }, is() { return query; }, gt() { return query; }, or() { return query; },
        async maybeSingle() {
          const hit = matching()[0] || null;
          if (patch) {
            if (!hit) return { data: null, error: null };
            Object.assign(hit, patch);
            updates.push({ table, patch, filters: [...filters] });
            return { data: { ...hit }, error: null };
          }
          return { data: hit ? { ...hit } : null, error: null };
        },
        async single() { return query.maybeSingle(); },
        then(resolve) { resolve({ data: matching(), error: null }); },
      };
      return query;
    },
  };
}

class Collection extends Map {
  find(fn) { for (const value of this.values()) if (fn(value)) return value; return undefined; }
  some(fn) { return Boolean(this.find(fn)); }
}

function fakeClient() {
  const sent = [];
  const edits = [];
  const button = (customId, disabled = false) => ({ type: 2, style: 1, label: "延長派單時間（+5 分鐘，限一次）", custom_id: customId, customId, disabled });
  const startMessage = {
    id: "400000000000000001",
    components: [{ type: 1, components: [button(`self_selection_extend_${ORDER_ID}`), button(`self_service_cancel_refund_${ORDER_ID}`)] }],
    async edit(payload) { edits.push({ id: this.id, payload }); return this; },
  };
  const orderChannel = {
    id: ORDER_CHANNEL,
    isTextBased: () => true,
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") return arg === startMessage.id ? startMessage : null;
        return new Collection([[startMessage.id, startMessage]]);
      },
    },
    async send(payload) { sent.push({ channel: ORDER_CHANNEL, payload }); return { id: "1" }; },
  };
  const dispatchChannel = {
    id: "dispatch",
    isTextBased: () => true,
    messages: { async fetch() { return new Collection(); } },
    async send(payload) { sent.push({ channel: "dispatch", payload }); return { id: "2" }; },
  };
  return {
    sent, edits,
    isReady: () => true,
    once() {},
    channels: { async fetch(id) { return id === ORDER_CHANNEL ? orderChannel : dispatchChannel; } },
    guilds: { cache: new Map(), async fetch() { return null; } },
  };
}

function orderRow(over = {}) {
  const now = new Date().toISOString();
  return {
    id: ORDER_ID, order_no: "QN-20261126-001", customer_id: OWNER, channel_id: ORDER_CHANNEL,
    quote_status: "self_dispatching", status: "pending", player_count: 1, preferred_player: null,
    note: `[SELF_SERVICE] [DISPATCH_AT:${new Date(Date.now() - 60_000).toISOString()}]`,
    service: "特戰英豪", updated_at: now, created_at: now, ...over,
  };
}

function quiet(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(run).finally(() => Object.assign(console, original));
}

test("core: owner extends once (+5 分), Discord buttons disabled, thread notice posted", () => quiet(async () => {
  const db = fakeDb([orderRow()]);
  const client = fakeClient();
  dispatchSystem.setup(db, client, {});
  const before = dispatchSystem.getSelfServiceSelectionDeadline(db.rows[0]);
  const result = await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID });
  assert.equal(result.ok, true);
  assert.equal(result.deadlineAt, before + 5 * 60_000);
  assert.match(db.rows[0].note, /\[DISPATCH_EXTENDED:1\]/);
  // Same optimistic guard as the button: id + customer + quote_status + updated_at.
  const keys = db.updates[0].filters.map(([key]) => key);
  assert.deepEqual(keys, ["id", "customer_id", "quote_status", "updated_at"]);
  // The 「延長派單時間」 button on the order-channel message is now disabled.
  const edited = client.edits.find((edit) => edit.id === "400000000000000001");
  assert.ok(edited, "extend button message edited");
  const [extendButton, cancelButton] = edited.payload.components[0].components;
  assert.equal(extendButton.data.custom_id, `self_selection_extend_${ORDER_ID}`);
  assert.equal(extendButton.data.disabled, true);
  assert.notEqual(cancelButton.data.disabled, true);
  const notice = client.sent.find((item) => /老闆已將選人時間延長 5 分鐘/.test(item.payload.content || ""));
  assert.ok(notice, "dispatch notice posted");
  assert.deepEqual(notice.payload.allowedMentions, { parse: [] });

  const again = await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID });
  assert.deepEqual(again, { ok: false, code: "already_extended" });
}));

test("core: refuses non-owner, wrong stage, untimed 人工派單, unknown order; by order_no works", () => quiet(async () => {
  const db = fakeDb([orderRow()]);
  dispatchSystem.setup(db, fakeClient(), {});
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OTHER, orderId: ORDER_ID }), { ok: false, code: "not_owner" });
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: "00000000-0000-4000-8000-000000000000" }), { ok: false, code: "not_found" });

  db.rows[0].quote_status = "waiting_payment";
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID }), { ok: false, code: "not_dispatching" });

  Object.assign(db.rows[0], { quote_status: "manual_dispatching", note: "[MANUAL_DISPATCH]", service_flow_key: "order:1" });
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID }), { ok: false, code: "no_deadline" });

  // APP／官網 需求 (website:) 人工派單 is timed and can be extended, here addressed by order_no.
  Object.assign(db.rows[0], { note: `[MANUAL_DISPATCH] [DISPATCH_AT:${new Date().toISOString()}]`, service_flow_key: "website:WEB-1" });
  const ok = await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderNo: "QN-20261126-001" });
  assert.equal(ok.ok, true);

  Object.assign(db.rows[0], { note: "no markers", quote_status: "self_dispatching" });
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID }), { ok: false, code: "not_found" });
}));

test("core: a stale row (updated meanwhile) answers stale and writes nothing", () => quiet(async () => {
  const db = fakeDb([orderRow()]);
  const original = db.from.bind(db);
  db.from = (table) => {
    const query = original(table);
    const update = query.update;
    query.update = (value) => { db.rows[0].updated_at = "2000-01-01T00:00:00.000Z"; return update(value); };
    return query;
  };
  dispatchSystem.setup(db, fakeClient(), {});
  assert.deepEqual(await dispatchSystem.extendDispatchForApp({ userId: OWNER, orderId: ORDER_ID }), { ok: false, code: "stale" });
  assert.doesNotMatch(db.rows[0].note, /DISPATCH_EXTENDED/);
}));

test("Discord button still goes through the shared core with the original replies", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const handler = source.slice(
    source.indexOf("async function extendSelfServiceSelectionTime(interaction)"),
    source.indexOf("// APP（經 app-api 簽章呼叫）"),
  );
  assert.match(handler, /extendClaimDispatchSelection\(order, \{/);
  assert.match(handler, /canCustomerOrStaffSubmit\(interaction, order\.customer_id\)/);
  assert.match(handler, /triggerMessage: interaction\.message/);
  for (const reply of [
    "❌ 找不到這張自助訂單。",
    "這張人工訂單沒有選人期限，不需要延長時間；請直接在原訂單選人。",
    "❌ 只有原下單者可以延長選人時間。",
    "❌ 這張訂單目前不在派單或選人階段。",
    "❌ 每筆訂單最多只能延長一次 5 分鐘。",
    "⚠️ 正在延長選人時間，請勿重複點擊。",
    "❌ 選人時間已結束，這張訂單已自動棄單。",
    "⚠️ 訂單狀態已更新，請重新查看最新的選人訊息。",
  ]) {
    assert.ok(source.includes(reply), reply);
  }
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /dispatch:require\('\.\/utils\/appDispatchExtend'\)\.createAppDispatchExtend\(\{extend:payload=>dispatchSystem\.extendDispatchForApp\(payload\)/);
});
