const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createAppDirectIssue } = require("../utils/appDirectIssue");

const row = (meta, status = "pending") => ({ merchant_trade_no: "QN7CF718502C995A3C31", status, metadata: meta });
const dbWith = (r) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: r, error: null }) }) }) }) });

test("relays an APP direct row to the website with the bot's signature and passes the answer through", async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init }; return { status: 200, json: async () => ({ payment_info: { method: "BARCODE" } }) }; };
  const d = createAppDirectIssue({ db: dbWith(row({ flow: "app", issue: "direct", method: "barcode" })), baseUrl: "https://site", signingKey: () => "k", fetchImpl });
  const r = await d.issue({ order: "QN7CF718502C995A3C31", method: "BARCODE" });
  assert.equal(r.status, 200);
  assert.equal(r.body.payment_info.method, "BARCODE");
  assert.equal(sent.url, "https://site/api/payments/ecpay/service/direct-issue");
  assert.equal(sent.init.headers["X-Ecpay-Bot-Signature"], createHmac("sha256", "k").update(sent.init.body).digest("hex"));
  assert.deepEqual(Object.keys(JSON.parse(sent.init.body)), ["order", "method", "timestamp"]);
});

test("refuses rows the APP did not create, or a different method", async () => {
  const fetchImpl = async () => { throw new Error("must not call"); };
  for (const meta of [{ flow: "self_service", issue: "direct", method: "barcode" }, { flow: "app", method: "barcode" }, { flow: "app", issue: "direct", method: "cvs" }]) {
    const d = createAppDirectIssue({ db: dbWith(row(meta)), signingKey: () => "k", fetchImpl });
    assert.equal((await d.issue({ order: "QN7CF718502C995A3C31", method: "BARCODE" })).status, 404);
  }
  const none = createAppDirectIssue({ db: dbWith(null), signingKey: () => "k", fetchImpl });
  assert.equal((await none.issue({ order: "QN7CF718502C995A3C31", method: "ATM" })).status, 404);
  assert.equal((await none.issue({ order: "bad order!", method: "ATM" })).status, 400);
});

test("website errors pass through; a timeout is 504 (may still be issuing)", async () => {
  const meta = { flow: "app", issue: "direct", method: "atm" };
  const d400 = createAppDirectIssue({ db: dbWith(row(meta)), signingKey: () => "k", fetchImpl: async () => ({ status: 400, json: async () => ({ error: "此付款單已開始建立付款資料" }) }) });
  assert.deepEqual(await d400.issue({ order: "QN7CF718502C995A3C31", method: "ATM" }), { status: 400, body: { error: "此付款單已開始建立付款資料" } });
  const dTimeout = createAppDirectIssue({ db: dbWith(row(meta)), signingKey: () => "k", logger: { error() {} }, fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  assert.equal((await dTimeout.issue({ order: "QN7CF718502C995A3C31", method: "ATM" })).status, 504);
});
