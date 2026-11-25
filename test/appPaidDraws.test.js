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
        const q = { select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; },
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
