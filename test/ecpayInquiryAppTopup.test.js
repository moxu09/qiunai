const test = require("node:test");
const assert = require("node:assert/strict");
const { recoverPendingEcpayPayments, isAppDirectTopup, APP_TOPUP_EXPIRY_GRACE_MS } = require("../utils/ecpayInquiry");

// APP 超商條碼／超商代碼／ATM 儲值 (app-api api/src/topupOffline.ts) in the 30-second scheduled inquiry.
// request is stubbed: nothing reaches the website, 綠界 or production.
const NOW = Date.parse("2026-11-26T06:00:00.000Z");
const CREATED = new Date(NOW - 3600000).toISOString();
const REQUEST = "11111111-2222-4333-8444-555555555555";
const AIO = { atm: "ATM", cvs: "CVS", barcode: "BARCODE" };

const appTopup = (no, method = "cvs", extra = {}, meta = {}) => ({
  merchant_trade_no: no, organization_code: "qiunai", payment_kind: "topup", status: "pending", created_at: CREATED, channel_id: "",
  metadata: { topupNo: "TOP-1", guildId: "g", note: "APP 超商／ATM 儲值", flow: "app", method, issue: "direct", requestId: REQUEST, ...meta },
  raw_result: { MerchantTradeNo: no, TradeNo: "2611260000000077", PaymentType: AIO[method], ExpireDate: method === "barcode" ? "2026/11/29" : "2026/11/29 10:00:00" },
  ...extra,
});
const draw = (no, org = "qiunai") => ({ merchant_trade_no: no, organization_code: org, payment_kind: "draw", status: "pending", created_at: CREATED,
  raw_result: { PaymentType: "CVS_CVS" }, metadata: { flow: "app" } });
const tradeNo = (n) => `QN${String(n).padStart(18, "0")}`;

// In-memory PostgREST stand-in: eq / in / gte / lte (ISO strings) and "col->>key" JSON text filters.
function tableDb(tables) {
  const queries = [];
  return {
    queries,
    from(table) {
      const filters = [];
      queries.push({ table, filters });
      const field = (r, k) => (k.includes("->>") ? ((v) => (v == null ? undefined : String(v)))(r[k.split("->>")[0]]?.[k.split("->>")[1]]) : r[k]);
      const match = (r) => filters.every(([k, v, op]) => (op === "gte" ? String(field(r, k)) >= v : op === "lte" ? String(field(r, k)) <= v
        : Array.isArray(v) ? v.includes(field(r, k)) : field(r, k) === v));
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { filters.push([k, v]); return q; }, in(k, v) { filters.push([k, v]); return q; },
        gte(k, v) { filters.push([k, v, "gte"]); return q; }, lte(k, v) { filters.push([k, v, "lte"]); return q; },
        async limit(n) { return { data: (tables[table] || []).filter(match).slice(0, n).map((r) => ({ ...r })), error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: (tables[table] || []).filter(match).map((r) => ({ ...r })), error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
}

// Mimics the website route's schedule: each check writes next_check_at = now + 300 s; a mismatch sets review_required.
function website(tables, answer) {
  const called = [];
  const request = async (no, opts) => {
    assert.deepEqual(opts, { source: "scheduled", baseUrl: "https://pay.example" });
    called.push(no);
    const status = await answer(no);
    tables.ecpay_service_inquiries = tables.ecpay_service_inquiries.filter((q) => q.merchant_trade_no !== no);
    tables.ecpay_service_inquiries.push({ merchant_trade_no: no, last_checked_at: new Date(website.now).toISOString(),
      next_check_at: new Date(website.now + 300000).toISOString(), review_required: status === "needs_review" });
    if (status === "paid") tables.ecpay_service_payments.find((p) => p.merchant_trade_no === no).status = "paid";
    return { status };
  };
  return { called, request };
}
website.now = NOW;

async function drain(tables, request, now = NOW) {
  website.now = now;
  for (let i = 0; i < 30; i++) {
    const r = await recoverPendingEcpayPayments(tableDb(tables), "https://pay.example", { now, request, terminalSkips: new Set() });
    if (!r.checked) return;
  }
  throw new Error("排程沒有收斂");
}

test("排程選單：只排入 APP 直接取號儲值與 draw；Discord／APP 信用卡／深夜儲值、方法不符、未取號、格式不符都不排入", async () => {
  const included = [appTopup(tradeNo(1), "atm"), appTopup(tradeNo(2), "cvs"), appTopup(tradeNo(3), "barcode"), draw("QDRAW1"), draw("DDRAW1", "deepnight")];
  const excluded = [
    appTopup(tradeNo(10), "atm", { metadata: { topupNo: "TOP-1", guildId: "g" } }), // Discord 儲值 (ATM 取號)
    appTopup(tradeNo(11), "cvs", { metadata: { topupNo: "TOP-1", guildId: "g", note: "APP 儲值", flow: "app" } }), // APP 信用卡儲值
    appTopup(tradeNo(12), "cvs", {}, { issue: "checkout" }),
    appTopup(tradeNo(13), "cvs", {}, { flow: "self_service" }),
    appTopup(tradeNo(14), "cvs", {}, { requestId: undefined }),
    appTopup(tradeNo(15), "cvs", { organization_code: "deepnight" }),
    appTopup("QN00000000000000abcd", "cvs"),
    appTopup("DN000000000000000016", "cvs"),
    appTopup(tradeNo(17), "cvs", { raw_result: { PaymentType: "ATM", TradeNo: "1", ExpireDate: "2026/11/29 10:00:00" } }), // 方法與 APP 選的不符
    appTopup(tradeNo(18), "cvs", { raw_result: null }), // 尚未取號
    appTopup(tradeNo(19), "cvs", { raw_result: { PaymentType: "Credit_CreditCard", TradeNo: "1" } }),
    appTopup(tradeNo(20), "cvs", { status: "paid" }),
    appTopup(tradeNo(21), "cvs", { payment_kind: "order" }),
  ];
  for (const row of included.filter((r) => r.payment_kind === "topup")) assert.equal(isAppDirectTopup(row), true, row.merchant_trade_no);
  const tables = { ecpay_service_payments: [...included, ...excluded], ecpay_service_inquiries: [] };
  const db = tableDb(tables);
  const { called, request } = website(tables, async () => "pending");
  for (let i = 0; i < 30; i++) {
    const r = await recoverPendingEcpayPayments(db, "https://pay.example", { now: NOW, request, terminalSkips: new Set() });
    if (!r.checked) break;
  }
  assert.deepEqual(called.sort(), included.map((r) => r.merchant_trade_no).sort());
  const kinds = db.queries.filter((q) => q.table === "ecpay_service_payments").map((q) => q.filters.find(([k]) => k === "payment_kind")[1]);
  assert.deepEqual([...new Set(kinds)].sort(), ["draw", "topup"]);
});

test("綠界已付款 → 官網入帳一次；之後付款單不再是待繳費，不再查單", async () => {
  const tables = { ecpay_service_payments: [appTopup(tradeNo(1))], ecpay_service_inquiries: [] };
  const { called, request } = website(tables, async () => "paid");
  await drain(tables, request);
  await drain(tables, request, NOW + 600000);
  await drain(tables, request, NOW + 3600000);
  assert.deepEqual(called, [tradeNo(1)]);
});

test("尚未付款 → 維持待繳費，依官網排程每 5 分鐘再查一次", async () => {
  const tables = { ecpay_service_payments: [appTopup(tradeNo(1), "atm")], ecpay_service_inquiries: [] };
  const { called, request } = website(tables, async () => "pending");
  await drain(tables, request);
  await drain(tables, request, NOW + 60000);
  assert.deepEqual(called, [tradeNo(1)], "冷卻期間不查");
  await drain(tables, request, NOW + 301000);
  assert.deepEqual(called, [tradeNo(1), tradeNo(1)]);
  assert.equal(tables.ecpay_service_payments[0].status, "pending");
});

test("金額不符（官網回 needs_review、標記待覆核）→ 不再排程查單", async () => {
  const tables = { ecpay_service_payments: [appTopup(tradeNo(1))], ecpay_service_inquiries: [] };
  const { called, request } = website(tables, async () => "needs_review");
  await drain(tables, request);
  await drain(tables, request, NOW + 3600000);
  assert.deepEqual(called, [tradeNo(1)]);
  assert.equal(tables.ecpay_service_payments[0].status, "pending");
});

test("繳費期限過後（含寬限）停止排程；寬限內仍查；條碼日期以當日結束計；超過 7 天的單不查", async () => {
  const expiredAt = (date) => ({ raw_result: { PaymentType: "CVS", TradeNo: "1", ExpireDate: date } });
  // 2026/11/25 05:00 台北 = 2026-11-24T21:00Z；NOW = 2026-11-26T06:00Z → 超過 24 h 寬限
  const longExpired = appTopup(tradeNo(1), "cvs", expiredAt("2026/11/25 05:00:00"));
  // 2026/11/26 10:00 台北 = 2026-11-26T02:00Z：已過期但仍在寬限內 → 仍查（期限前一刻繳費、通知遺失）
  const inGrace = appTopup(tradeNo(2), "cvs", expiredAt("2026/11/26 10:00:00"));
  // 條碼 2026/11/25 → 當日 23:59:59 台北 = 2026-11-25T15:59:59Z；+24 h = 2026-11-26T15:59:59Z > NOW → 仍查
  const barcodeDay = appTopup(tradeNo(3), "barcode", { raw_result: { PaymentType: "BARCODE", TradeNo: "1", ExpireDate: "2026/11/25" } });
  const barcodeOld = appTopup(tradeNo(4), "barcode", { raw_result: { PaymentType: "BARCODE", TradeNo: "1", ExpireDate: "2026/11/24" } });
  const weekOld = appTopup(tradeNo(5), "cvs", { created_at: new Date(NOW - 8 * 86400000).toISOString() });
  const tables = { ecpay_service_payments: [longExpired, inGrace, barcodeDay, barcodeOld, weekOld], ecpay_service_inquiries: [] };
  const { called, request } = website(tables, async () => "pending");
  await drain(tables, request);
  assert.deepEqual(called.sort(), [tradeNo(2), tradeNo(3)]);
  called.length = 0;
  // 一天後兩張也都過了寬限 → 完全停止
  await drain(tables, request, NOW + 86400000);
  assert.deepEqual(called, []);
  assert.equal(APP_TOPUP_EXPIRY_GRACE_MS, 24 * 3600000);
});

test("draw 單不受儲值期限規則影響（維持原本 7 天視窗）", async () => {
  const oldCode = { ...draw("QDRAW1"), raw_result: { PaymentType: "CVS_CVS", ExpireDate: "2026/11/20 10:00:00" } };
  const tables = { ecpay_service_payments: [oldCode], ecpay_service_inquiries: [] };
  const { called, request } = website(tables, async () => "pending");
  await drain(tables, request);
  assert.deepEqual(called, ["QDRAW1"]);
});

test("任一查詢失敗 → 拋錯，不送出查單", async () => {
  const failing = { from() { let kind; const q = { select() { return q; }, order() { return q; }, in() { return q; }, gte() { return q; }, lte() { return q; },
    eq(k, v) { if (k === "payment_kind") kind = v; return q; }, async limit() { return kind === "topup" ? { data: null, error: { message: "boom" } } : { data: [], error: null }; } }; return q; } };
  await assert.rejects(recoverPendingEcpayPayments(failing, "https://pay.example", { request: async () => { throw new Error("不應查單"); } }), /無法讀取待付款查單清單/);
});
