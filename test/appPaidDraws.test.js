const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppPaidDrawFulfiller, BROADCAST_CHANNEL_ID } = require("../utils/appPaidDraws");

const TRADE = "QD0123456789ABCDEF01";
const REQUEST = "11111111-2222-4333-8444-555555555555";

function fakes({ rpcResult = null, rpcError = null, insertData = [{ request_id: REQUEST }], insertError = null, row = null } = {}) {
  const calls = { rpc: [], inserts: [], posts: [], fetched: [], selects: [] };
  const supabase = {
    async rpc(name, args) { calls.rpc.push({ name, args }); return { data: rpcResult, error: rpcError }; },
    from(table) {
      const q = {
        select(cols) { calls.selects.push({ table, cols }); return q; },
        eq() { return q; },
        async maybeSingle() { return { data: row, error: null }; },
        upsert(value, opts) { calls.inserts.push({ table, value, opts }); return q; },
        then(resolve, reject) { return Promise.resolve({ data: insertData, error: insertError }).then(resolve, reject); },
      };
      return q;
    },
  };
  const client = {
    channels: {
      async fetch(id) {
        calls.fetched.push(id);
        return { async send(payload) { calls.posts.push({ id, payload }); } };
      },
    },
  };
  return { supabase, client, calls };
}

const metadata = (extra = {}) => ({
  flow: "app", requestId: REQUEST, brand: "qiunai", kind: "ichiban", poolId: "p1", count: 1, unitPrice: 300,
  method: "credit", guildId: "g", broadcast: { anonymous: true }, displayName: "小明", ...extra,
});
const payment = (extra = {}) => ({
  id: 7, payment_kind: "draw", platform_order_id: TRADE, merchant_trade_no: TRADE, provider: "ecpay",
  organization_code: "qiunai", user_id: "123", amount: 300, channel_id: "", entity_key: REQUEST, metadata: metadata(), ...extra,
});
const drawn = (extra = {}) => ({ outcome: "drawn", kind: "ichiban", results: [{ tier: "S", prizeName: "秋奈等身抱枕" }], tier: "S", prizeName: "秋奈等身抱枕", balance: 10, ...extra });

test("draw 付款呼叫 app_paid_draw_fulfill，S 賞匿名播報一次且不提及任何人", async () => {
  const { supabase, client, calls } = fakes({ rpcResult: drawn() });
  const fulfil = createAppPaidDrawFulfiller({ supabase, client, env: {} });
  const result = await fulfil(payment());
  assert.equal(result.outcome, "drawn");
  assert.deepEqual(calls.rpc, [{ name: "app_paid_draw_fulfill", args: { p_merchant_trade_no: TRADE } }]);
  assert.equal(BROADCAST_CHANNEL_ID, "1575175224612225115");
  assert.deepEqual(calls.fetched, ["1575175224612225115"]);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].payload.content, "🎉 恭喜 匿名老闆 在 APP 一番賞抽中 S 賞｜秋奈等身抱枕！");
  assert.deepEqual(calls.posts[0].payload.allowedMentions, { parse: [] });
  assert.equal(calls.inserts[0].table, "app_draw_broadcasts");
  assert.equal(calls.inserts[0].value.request_id, REQUEST);
  assert.equal(calls.inserts[0].value.anonymous, true);
  assert.deepEqual(calls.inserts[0].opts, { onConflict: "request_id", ignoreDuplicates: true });
});

test("不匿名時以 APP 暱稱播報並跳脫 markdown／mention；頻道可由 env 覆寫", async () => {
  const { supabase, client, calls } = fakes({ rpcResult: drawn({ tier: "A", prizeName: "**抱枕**" }) });
  const fulfil = createAppPaidDrawFulfiller({ supabase, client, env: { ICHIBAN_BROADCAST_CHANNEL_ID: "1234567890123456789" } });
  await fulfil(payment({ metadata: metadata({ broadcast: { anonymous: false }, displayName: "<@123> _小明_" }) }));
  assert.deepEqual(calls.fetched, ["1234567890123456789"]);
  const content = calls.posts[0].payload.content;
  assert.match(content, /^🎉 恭喜 /);
  assert.doesNotMatch(content, /<@1/);
  assert.match(content, /\\_小明\\_/);
  assert.match(content, /抽中 A 賞｜\\\*\\\*抱枕\\\*\\\*！$/);
  assert.equal(calls.inserts[0].value.anonymous, false);
});

test("暱稱缺少或 broadcast 未設定時一律匿名", async () => {
  for (const meta of [metadata({ broadcast: { anonymous: false }, displayName: null }), metadata({ broadcast: undefined })]) {
    const { supabase, client, calls } = fakes({ rpcResult: drawn() });
    await createAppPaidDrawFulfiller({ supabase, client, env: {} })(payment({ metadata: meta }));
    assert.match(calls.posts[0].payload.content, /恭喜 匿名老闆 在/);
  }
});

test("重送結果、轉 ASD、扭蛋、B 賞以下與已播報過的都不播報", async () => {
  const cases = [
    { rpcResult: drawn({ already_processed: true }) },
    { rpcResult: drawn({ alreadyProcessed: true }) },
    { rpcResult: { outcome: "credited_asd", kind: "ichiban", results: [], creditedAsd: 300, balance: 300, tier: "S", prizeName: "x" } },
    { rpcResult: { outcome: "drawn", kind: "gacha", results: [{ tier: "SSR", prizeName: "x" }], balance: 1 } },
    { rpcResult: drawn({ tier: "B", prizeName: "小獎", results: [{ tier: "B", prizeName: "小獎" }] }) },
    { rpcResult: drawn(), insertData: [] },
  ];
  for (const c of cases) {
    const { supabase, client, calls } = fakes(c);
    const result = await createAppPaidDrawFulfiller({ supabase, client, env: {} })(payment());
    assert.ok(result, "回傳結果視為成功");
    assert.equal(calls.posts.length, 0, JSON.stringify(c));
  }
});

test("付款單沒有 metadata 時從 ecpay_service_payments 讀取", async () => {
  const { supabase, client, calls } = fakes({ rpcResult: drawn(), row: { metadata: metadata({ broadcast: { anonymous: false }, displayName: "小明" }) } });
  await createAppPaidDrawFulfiller({ supabase, client, env: {} })(payment({ metadata: undefined }));
  assert.ok(calls.selects.some((s) => s.table === "ecpay_service_payments"));
  assert.match(calls.posts[0].payload.content, /恭喜 小明 在/);
});

test("播報失敗不影響入帳結果", async () => {
  const { supabase, calls } = fakes({ rpcResult: drawn() });
  const client = { channels: { async fetch() { throw new Error("discord down"); } } };
  const result = await createAppPaidDrawFulfiller({ supabase, client, env: {}, log: () => {} })(payment());
  assert.equal(result.outcome, "drawn");
  assert.equal(calls.posts.length, 0);
});

test("播報紀錄寫入失敗仍以非重送結果播報一次", async () => {
  const { supabase, client, calls } = fakes({ rpcResult: drawn(), insertError: { message: "relation does not exist" } });
  await createAppPaidDrawFulfiller({ supabase, client, env: {}, log: () => {} })(payment());
  assert.equal(calls.posts.length, 1);
});

test("RPC 錯誤以中文訊息拋出（交由既有失敗處理重試）；空結果也視為失敗；非 draw 單拒絕", async () => {
  const notPaid = fakes({ rpcError: { message: "payment not paid" } });
  await assert.rejects(createAppPaidDrawFulfiller({ supabase: notPaid.supabase, client: notPaid.client, env: {} })(payment()), /綠界付款抽獎入帳失敗：payment not paid/);
  assert.equal(notPaid.calls.posts.length, 0);
  const empty = fakes({ rpcResult: null });
  await assert.rejects(createAppPaidDrawFulfiller({ supabase: empty.supabase, client: empty.client, env: {} })(payment()), /綠界付款抽獎入帳失敗/);
  const other = fakes({ rpcResult: drawn() });
  await assert.rejects(createAppPaidDrawFulfiller({ supabase: other.supabase, client: other.client, env: {} })(payment({ provider: "jkopay" })), /不是綠界抽獎付款單/);
  assert.equal(other.calls.rpc.length, 0);
});

test("綠界補償迴圈把 draw 單交給抽獎入帳；RPC 失敗時以中文訊息標記失敗待重試", async () => {
  const { createEcpayService } = require("../utils/ecpay");
  for (const fail of [false, true]) {
    const row = { id: 9, organization_code: "qiunai", payment_kind: "draw", merchant_trade_no: TRADE, status: "paid", amount: 300, metadata: metadata() };
    const finishes = [];
    const rpcNames = [];
    const supabase = {
      from(table) {
        const q = { select() { return q; }, eq() { return q; }, in() { return q; }, or() { return q; }, order() { return q; },
          async limit() { return { data: [row], error: null }; },
          upsert() { return q; },
          then(resolve, reject) { return Promise.resolve({ data: [{ request_id: REQUEST }], error: null }).then(resolve, reject); } };
        return q;
      },
      async rpc(name, args) {
        rpcNames.push(name);
        if (name === "ecpay_claim_service_fulfillment") return { data: { ...row, trade_no: "T1", claimed: true, attempt: 1 }, error: null };
        if (name === "ecpay_finish_service_fulfillment") { finishes.push(args.p_error); return { data: true, error: null }; }
        if (name === "app_paid_draw_fulfill") return fail ? { data: null, error: { message: "boom" } } : { data: drawn({ tier: "C" }), error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
    };
    const fulfil = createAppPaidDrawFulfiller({ supabase, client: { channels: { async fetch() { throw new Error("no post expected"); } } }, env: {}, log: () => {} });
    const service = createEcpayService({ supabase, env: { ECPAY_PUBLIC_BASE_URL: "https://pay.example" },
      onServicePaid: async ({ payment: paid }) => { assert.equal(paid.platform_order_id, TRADE); await fulfil(paid); } });
    const origError = console.error; console.error = () => {};
    const summary = await service.recoverPaidFulfillments().finally(() => { console.error = origError; });
    assert.deepEqual(rpcNames, ["ecpay_claim_service_fulfillment", "app_paid_draw_fulfill", "ecpay_finish_service_fulfillment"]);
    if (fail) { assert.equal(summary.failed, 1); assert.match(finishes[0], /綠界付款抽獎入帳失敗：boom/); }
    else { assert.equal(summary.completed, 1); assert.equal(finishes[0], null); }
  }
});

test("ATM／超商的 draw 待繳單與儲值單一樣納入 30 秒查單", async () => {
  const { recoverPendingEcpayPayments } = require("../utils/ecpayInquiry");
  const rows = [{ merchant_trade_no: TRADE, raw_result: { PaymentType: "CVS_CVS" }, metadata: metadata({ method: "cvs" }) }];
  const db = { from() { const q = { select() { return q; }, eq() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; }, in() { return q; },
    limit() { return Promise.resolve({ data: rows, error: null }); }, then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return q; } };
  const called = [];
  await recoverPendingEcpayPayments(db, "https://pay.example", { request: async (no) => { called.push(no); return { status: "pending" }; } });
  assert.deepEqual(called, [TRADE]);
});

// ---- Round 2: real Task 1 shape/errors, deepnight draw rows, inquiry selection ----
const { PERMANENT_FAILURE_PREFIX } = require("../utils/ecpay");

// Real app_paid_draw_fulfill answer (20261126120000_app_paid_draws.sql): snake_case already_processed, top-level
// tier/prizeName for 一番賞, results[0] carries tier/name/reward_coins.
const realIchiban = (extra = {}) => ({
  merchant_trade_no: TRADE, request_id: REQUEST, already_processed: false, outcome: "drawn", kind: "ichiban", brand: "qiunai",
  count: 1, unit_price: 300, amount: 300, draw_id: 1, tier: "A", prizeName: "抱枕", prize_id: 2, ticket_no: 5, is_last_one: false,
  results: [{ tier: "A", name: "抱枕", reward_coins: 0 }], balance: 0, ...extra,
});

test("真實回傳格式：A 賞播報；已處理重送（already_processed:true）不播報", async () => {
  const fresh = fakes({ rpcResult: realIchiban() });
  await createAppPaidDrawFulfiller({ supabase: fresh.supabase, client: fresh.client, env: {} })(payment());
  assert.equal(fresh.calls.posts[0].payload.content, "🎉 恭喜 匿名老闆 在 APP 一番賞抽中 A 賞｜抱枕！");
  const replay = fakes({ rpcResult: realIchiban({ already_processed: true }) });
  await createAppPaidDrawFulfiller({ supabase: replay.supabase, client: replay.client, env: {} })(payment());
  assert.equal(replay.calls.posts.length, 0);
  const onlyResults = fakes({ rpcResult: realIchiban({ tier: undefined, prizeName: undefined, results: [{ tier: "S", name: "大獎" }] }) });
  await createAppPaidDrawFulfiller({ supabase: onlyResults.supabase, client: onlyResults.client, env: {} })(payment());
  assert.match(onlyResults.calls.posts[0].payload.content, /抽中 S 賞｜大獎！$/);
});

test("「付款尚未完成」與連線錯誤可重試；資料不符等錯誤標為需人工核對", async () => {
  const run = async (message) => {
    const f = fakes({ rpcError: { message } });
    return createAppPaidDrawFulfiller({ supabase: f.supabase, client: f.client, env: {} })(payment()).then(() => null, (e) => e);
  };
  for (const message of ["付款尚未完成", "fetch failed", "canceling statement due to lock timeout"]) {
    const error = await run(message);
    assert.ok(!error.message.startsWith(PERMANENT_FAILURE_PREFIX), message);
    assert.equal(error.permanent, false);
    assert.match(error.message, /綠界付款抽獎入帳失敗/);
  }
  for (const message of ["付款金額與抽獎內容不符", "付款單抽獎資料無效", "付款單會員資料無效", "付款單店家資料無效", "只能單抽或十抽",
    "一番賞只限秋奈", "一番賞付款抽一次只能抽一張", "付款單不是抽獎付款", "找不到付款單", "付款單編號格式錯誤", "卡池權重設定錯誤"]) {
    const error = await run(message);
    assert.ok(error.message.startsWith(`${PERMANENT_FAILURE_PREFIX}綠界付款抽獎入帳失敗：${message}`), message);
    assert.equal(error.permanent, true);
  }
});

// Fake that honours eq/in filters so tests can prove which rows each query reaches.
function tableDb(tables) {
  const queries = [];
  return {
    queries,
    from(table) {
      const filters = [];
      queries.push({ table, filters });
      const ors = [];
      let orderBy = null;
      queries[queries.length - 1].ors = ors;
      // PostgREST or(): only "col.is.null" and "col.not.like.prefix*" are needed here.
      const orMatch = (r, expr) => expr.split(",").some((part) => {
        const [col, ...rest] = part.split(".");
        const op = rest.join(".");
        if (op === "is.null") return r[col] == null;
        if (op.startsWith("neq.")) return r[col] !== op.slice(4);
        if (op.startsWith("not.like.")) return r[col] != null && !String(r[col]).startsWith(op.slice(9).replace(/\*$/, ""));
        throw new Error(`unsupported or ${part}`);
      });
      const rows = () => (tables[table] || []).filter((r) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))
        && ors.every((expr) => orMatch(r, expr)))
        .sort((a, b) => (orderBy ? String(a[orderBy] ?? "").localeCompare(String(b[orderBy] ?? "")) : 0));
      const q = {
        select() { return q; }, gte() { return q; }, lte() { return q; },
        order(col) { orderBy = col; return q; },
        or(expr) { ors.push(expr); return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        in(k, v) { filters.push([k, v]); return q; },
        async limit(n) { return { data: rows().slice(0, n), error: null }; },
        async maybeSingle() { return { data: rows()[0] || null, error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
}

test("補償迴圈：深夜只處理 draw 單，深夜儲值／訂單不碰；需人工核對的 draw 單不再重試；未設定時行為不變", async () => {
  const { createEcpayService } = require("../utils/ecpay");
  const paid = (id, org, kind, extra = {}) => ({ id, organization_code: org, payment_kind: kind, merchant_trade_no: `T${id}`, status: "paid", fulfillment_status: "pending", amount: 100, ...extra });
  const rows = [
    paid(1, "qiunai", "topup"), paid(2, "deepnight", "topup"), paid(3, "deepnight", "order"), paid(4, "deepnight", "draw"),
    paid(5, "qiunai", "draw", { fulfillment_status: "failed", fulfillment_error: `${PERMANENT_FAILURE_PREFIX}綠界付款抽獎入帳失敗：付款金額與抽獎內容不符` }),
    paid(6, "qiunai", "draw", { fulfillment_status: "failed", fulfillment_error: "綠界付款抽獎入帳失敗：付款尚未完成" }),
    paid(7, "deepnight", "draw", { fulfillment_status: "failed", fulfillment_error: `${PERMANENT_FAILURE_PREFIX}x` }),
    paid(8, "qiunai", "order", { fulfillment_status: "failed", fulfillment_error: `${PERMANENT_FAILURE_PREFIX}x` }),
  ];
  for (const drawOrganizationCodes of [["deepnight"], undefined]) {
    const db = tableDb({ ecpay_service_payments: rows });
    const claimed = [];
    db.rpc = async (name, args) => {
      if (name === "ecpay_claim_service_fulfillment") { claimed.push(args.p_payment_id); return { data: { ...rows.find((r) => r.id === args.p_payment_id), claimed: true, attempt: 1 }, error: null }; }
      return { data: true, error: null };
    };
    const handled = [];
    const service = createEcpayService({ supabase: db, env: { ECPAY_PUBLIC_BASE_URL: "https://pay.example" }, drawOrganizationCodes,
      onServicePaid: async ({ payment: p }) => handled.push(`${p.organization_code}:${p.payment_kind}:${p.id}`) });
    const summary = await service.recoverPaidFulfillments();
    if (drawOrganizationCodes) {
      assert.deepEqual(handled.sort(), ["deepnight:draw:4", "qiunai:draw:6", "qiunai:order:8", "qiunai:topup:1"]);
      const deepQuery = db.queries.find((q) => q.filters.some(([k, v]) => k === "organization_code" && [].concat(v).includes("deepnight")));
      assert.deepEqual(deepQuery.filters.find(([k]) => k === "organization_code")[1], ["deepnight"]);
      assert.ok(deepQuery.filters.some(([k, v]) => k === "payment_kind" && v === "draw"));
      assert.equal(summary.skipped, 0, "需人工核對的單在查詢就排除");
    } else {
      assert.equal(summary.skipped, 0);
      assert.deepEqual(handled.sort(), ["qiunai:draw:6", "qiunai:order:8", "qiunai:topup:1"]);
      assert.equal(db.queries.length, 1);
    }
    assert.ok(!claimed.includes(2) && !claimed.includes(3) && !claimed.includes(5) && !claimed.includes(7));
  }
});

test("查單選擇：draw 單含超商條碼與深夜 draw 單；其他單維持秋奈 ATM／超商代碼", async () => {
  const { recoverPendingEcpayPayments } = require("../utils/ecpayInquiry");
  const pending = (no, org, kind, type) => ({ merchant_trade_no: no, organization_code: org, payment_kind: kind, status: "pending", raw_result: { PaymentType: type }, metadata: {} });
  const rows = [
    pending("Q_TOPUP_ATM", "qiunai", "topup", "ATM_LAND"),
    pending("Q_TOPUP_BAR", "qiunai", "topup", "BARCODE_BARCODE"),
    pending("Q_DRAW_BAR", "qiunai", "draw", "BARCODE_BARCODE"),
    pending("Q_DRAW_CARD", "qiunai", "draw", "Credit_CreditCard"),
    { ...pending("Q_DRAW_DIRECT", "qiunai", "draw", undefined), raw_result: null, metadata: { ecpay_direct_method: "CVS_CVS" } },
    pending("D_DRAW_CVS", "deepnight", "draw", "CVS_CVS"),
    pending("D_DRAW_BAR", "deepnight", "draw", "BARCODE_BARCODE"),
    pending("D_TOPUP_ATM", "deepnight", "topup", "ATM_LAND"),
    pending("D_ORDER_CVS", "deepnight", "order", "CVS_CVS"),
  ];
  const checks = [];
  const db = tableDb({ ecpay_service_payments: rows, ecpay_service_inquiries: checks });
  const called = [];
  for (let i = 0; i < 20; i++) {
    const result = await recoverPendingEcpayPayments(db, "https://pay.example", { request: async (no, opts) => {
      assert.deepEqual(opts, { source: "scheduled", baseUrl: "https://pay.example" });
      called.push(no);
      checks.push({ merchant_trade_no: no, next_check_at: new Date(Date.now() + 3600000).toISOString() });
      return { status: "pending" };
    } });
    if (!result.checked) break;
  }
  // Round 4: 官網查單 route 只接受 draw（其他類型回 409），排程只選 draw 單；儲值等其他單不再排入。
  assert.deepEqual(called.sort(), ["D_DRAW_BAR", "D_DRAW_CVS", "Q_DRAW_BAR", "Q_DRAW_DIRECT"]);
  const paymentQueries = db.queries.filter((q) => q.table === "ecpay_service_payments");
  assert.ok(paymentQueries.length > 0);
  for (const q of paymentQueries) {
    assert.ok(q.filters.some(([k, v]) => k === "payment_kind" && v === "draw"), "每個排程查詢都限定 draw");
    assert.deepEqual(q.filters.find(([k]) => k === "organization_code")[1], ["qiunai", "deepnight"]);
  }
});

test("需人工核對的 draw 單在標記失敗後私訊老闆名單一次（不提及、不含其他客人資料）", async () => {
  const { createEcpayService } = require("../utils/ecpay");
  const { createPaidDrawFailureAlert } = require("../utils/appPaidDraws");
  const sent = [];
  const client = { users: { async fetch(id) { return { async send(p) { sent.push({ id, p }); } }; } } };
  const alert = createPaidDrawFailureAlert({ client, recipientIds: "" });
  const order = [];
  const row = { id: 3, organization_code: "deepnight", payment_kind: "draw", merchant_trade_no: TRADE, status: "paid", fulfillment_status: "pending",
    amount: 300, user_id: "123456789012345678", metadata: metadata({ displayName: "秘密暱稱" }) };
  for (const message of ["付款金額與抽獎內容不符", "付款金額與抽獎內容不符", "付款尚未完成"]) {
    const supabase = {
      from() { const q = { select() { return q; }, eq() { return q; }, in() { return q; }, or() { return q; }, order() { return q; }, async limit() { return { data: [row], error: null }; } }; return q; },
      async rpc(name, args) {
        if (name === "ecpay_claim_service_fulfillment") return { data: { ...row, claimed: true, attempt: 1 }, error: null };
        if (name === "ecpay_finish_service_fulfillment") { order.push(`finish:${args.p_error}`); return { data: true, error: null }; }
        if (name === "app_paid_draw_fulfill") return { data: null, error: { message } };
        throw new Error(name);
      },
    };
    const fulfil = createAppPaidDrawFulfiller({ supabase, client, env: {} });
    const service = createEcpayService({ supabase, env: { ECPAY_PUBLIC_BASE_URL: "https://pay.example" },
      onServicePaid: async ({ payment: p }) => fulfil(p),
      onPermanentFailure: async (input) => { order.push("alert"); return alert(input); } });
    const origError = console.error; console.error = () => {};
    await service.recoverPaidFulfillments().finally(() => { console.error = origError; });
  }
  assert.equal(sent.length, 1, "同一交易編號只通知一次；可重試錯誤不通知");
  assert.equal(sent[0].id, "847840193859682304");
  assert.ok(order.indexOf("alert") > order.findIndex((o) => o.startsWith("finish:【需人工核對】")));
  assert.deepEqual(sent[0].p.allowedMentions, { parse: [] });
  const lines = sent[0].p.content.split("\n");
  assert.equal(lines[0], `⚠️ APP 付款抽獎無法自動處理：${TRADE}｜300 元｜請到後台確認（客人已付款）`);
  assert.equal(lines[1], "客人：<@123456789012345678>");
  assert.equal(lines[2], "原因：綠界付款抽獎入帳失敗：付款金額與抽獎內容不符");
  assert.doesNotMatch(sent[0].p.content, /秘密暱稱/);
});

test("通知名單取 APP_PRIZE_CLAIM_NOTIFY_USER_IDS；私訊失敗不拋錯；非 draw 單不通知", async () => {
  const { createPaidDrawFailureAlert } = require("../utils/appPaidDraws");
  const sent = [];
  const client = { users: { async fetch(id) { if (id === "222222222222222222") throw new Error("no dm"); return { async send(p) { sent.push(id); } }; } } };
  const alert = createPaidDrawFailureAlert({ client, recipientIds: "111111111111111111,222222222222222222", log: () => {} });
  assert.equal(await alert({ payment: { payment_kind: "topup", merchant_trade_no: "QN1", amount: 1 }, error: new Error("x") }), false);
  assert.equal(await alert({ payment: { payment_kind: "draw", merchant_trade_no: "QD1", amount: 1, user_id: "<@evil>" }, error: new Error("【需人工核對】x") }), true);
  assert.deepEqual(sent, ["111111111111111111"]);
});

test("需人工核對的 draw 單在查詢中就排除，超過 limit 筆也不會卡住其他補償（秋奈與深夜查詢皆是）", async () => {
  const { createEcpayService } = require("../utils/ecpay");
  const stuck = Array.from({ length: 45 }, (_, i) => ({ id: 100 + i, organization_code: i % 2 ? "deepnight" : "qiunai", payment_kind: "draw", merchant_trade_no: `P${i}`,
    status: "paid", fulfillment_status: "failed", fulfillment_error: `${PERMANENT_FAILURE_PREFIX}綠界付款抽獎入帳失敗：付款金額與抽獎內容不符`,
    fulfillment_updated_at: `2026-11-01T00:00:${String(i).padStart(2, "0")}Z` }));
  const rows = [...stuck,
    { id: 1, organization_code: "qiunai", payment_kind: "topup", merchant_trade_no: "T1", status: "paid", fulfillment_status: "failed", fulfillment_error: "x", fulfillment_updated_at: "2026-11-20T00:00:00Z" },
    { id: 2, organization_code: "deepnight", payment_kind: "draw", merchant_trade_no: "T2", status: "paid", fulfillment_status: "pending", fulfillment_error: null, fulfillment_updated_at: "2026-11-20T00:00:00Z" }];
  const db = tableDb({ ecpay_service_payments: rows });
  db.rpc = async (name, args) => name === "ecpay_claim_service_fulfillment"
    ? { data: { ...rows.find((r) => r.id === args.p_payment_id), claimed: true, attempt: 1 }, error: null } : { data: true, error: null };
  const handled = [];
  const service = createEcpayService({ supabase: db, env: { ECPAY_PUBLIC_BASE_URL: "https://pay.example" }, drawOrganizationCodes: ["deepnight"],
    onServicePaid: async ({ payment: p }) => handled.push(p.id) });
  const summary = await service.recoverPaidFulfillments();
  assert.deepEqual(handled.sort(), [1, 2]);
  assert.equal(summary.candidates, 2);
  assert.equal(db.queries.length, 2);
  for (const q of db.queries) assert.deepEqual(q.ors, [`payment_kind.neq.draw,fulfillment_error.is.null,fulfillment_error.not.like.${PERMANENT_FAILURE_PREFIX}*`]);
});

test("查單：只送 draw 單；查詢失敗拋錯；官網回 409 視為此單終止、之後不再排入，其他錯誤照舊拋出", async () => {
  const { recoverPendingEcpayPayments, requestEcpayInquiry } = require("../utils/ecpayInquiry");
  const rows = [
    { merchant_trade_no: "QDRAW1", organization_code: "qiunai", payment_kind: "draw", status: "pending", raw_result: { PaymentType: "BARCODE_BARCODE" } },
    { merchant_trade_no: "QDRAW2", organization_code: "deepnight", payment_kind: "draw", status: "pending", raw_result: { PaymentType: "ATM_LAND" } },
    { merchant_trade_no: "QTOPUP", organization_code: "qiunai", payment_kind: "topup", status: "pending", raw_result: { PaymentType: "ATM_LAND" } },
  ];
  const checks = [{ merchant_trade_no: "QDRAW2", last_checked_at: new Date(Date.now() - 1000).toISOString() }];
  const terminalSkips = new Set();
  const conflict = async () => { const e = new Error("x"); e.status = 409; e.terminal = true; throw e; };
  const called = [];
  const first = await recoverPendingEcpayPayments(tableDb({ ecpay_service_payments: rows, ecpay_service_inquiries: checks }), "https://pay.example",
    { terminalSkips, request: async (no, o) => { called.push(no); return conflict(no, o); } });
  assert.deepEqual(first, { checked: 1, status: "unsupported" });
  assert.deepEqual([...terminalSkips], ["QDRAW1"]);
  const second = await recoverPendingEcpayPayments(tableDb({ ecpay_service_payments: rows, ecpay_service_inquiries: checks }), "https://pay.example",
    { terminalSkips, request: async (no) => { called.push(no); return { status: "pending" }; } });
  assert.deepEqual(second, { checked: 1, status: "pending" });
  assert.deepEqual(called, ["QDRAW1", "QDRAW2"]);
  await assert.rejects(recoverPendingEcpayPayments(tableDb({ ecpay_service_payments: rows }), "https://pay.example",
    { terminalSkips: new Set(), request: async () => { throw new Error("查詢暫時無法完成"); } }), /查詢暫時無法完成/);
  const failing = { from() { const q = { select() { return q; }, eq() { return q; }, in() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; },
    async limit() { return { data: null, error: { message: "boom" } }; } }; return q; } };
  await assert.rejects(recoverPendingEcpayPayments(failing, "https://pay.example", { request: async () => ({}) }), /無法讀取待付款查單清單/);
  // requestEcpayInquiry: 409 標記為 terminal，訊息維持原樣（手動查單按鈕顯示不變）
  const r409 = await requestEcpayInquiry("QTOPUP", { source: "manual", baseUrl: "https://pay.example", secret: "s",
    fetcher: async () => ({ ok: false, status: 409 }) }).then(() => null, (e) => e);
  assert.equal(r409.terminal, true);
  assert.equal(r409.status, 409);
  assert.equal(r409.message, "查詢暫時無法完成，請稍後再試；勿重複付款");
  const r500 = await requestEcpayInquiry("QTOPUP", { source: "manual", baseUrl: "https://pay.example", secret: "s",
    fetcher: async () => ({ ok: false, status: 500 }) }).then(() => null, (e) => e);
  assert.ok(!r500.terminal);
});

test("手動「我已付款」按鈕：非 draw 單遇官網 409 與原本失敗（路由不存在 404）顯示完全相同訊息，且不寫入任何資料", async () => {
  const { handleEcpayInquiry } = require("../utils/ecpayInquiry");
  const writes = [];
  const db = { from(table) {
    const q = { select() { return q; }, eq() { return q; },
      async maybeSingle() { return { data: { user_id: "u", channel_id: "c", organization_code: "qiunai", payment_kind: "topup" }, error: null }; },
      insert() { writes.push(table); return q; }, update() { writes.push(table); return q; }, upsert() { writes.push(table); return q; } };
    return q;
  } };
  const origFetch = globalThis.fetch;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  const replyFor = async (status) => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: false, status, async json() { return { error: "此付款類型不支援自動查詢" }; } }; };
    const replies = [];
    await handleEcpayInquiry({ customId: "ecpay_inquiry_QN123", user: { id: "u" }, channelId: "c", deferred: true, async editReply(p) { replies.push(p); } }, db, "https://pay.example");
    assert.equal(calls, 1, "只呼叫一次，不重試");
    return replies;
  };
  try {
    const before = await replyFor(404);
    const after = await replyFor(409);
    assert.deepEqual(after, before);
    assert.deepEqual(after, [{ content: "❌ 查詢暫時無法完成，請稍後再試；勿重複付款" }]);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});
