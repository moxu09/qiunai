const assert = require("node:assert/strict");
const test = require("node:test");
const { buildEcpayPaymentRows, handleEcpayDirect, sendPreferredEcpayDirect } = require("../utils/ecpayDiscord");
const { getPaymentMethodSelection } = require("../utils/paymentMethodEmojis");
const { ECPAY_ATM_START, isEcpayAtmAvailable } = require("../utils/ecpayAtmSchedule");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PNG } = require("pngjs");

const order = "QN123456789012345678";
const payment = { platformOrderId: order, paymentUrl: `https://pay.example/payments/ecpay/service/checkout?order=${order}` };

test("綠界刷卡留在站內；ATM 與超商由機器人直接取號", () => {
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  try {
  const rows = buildEcpayPaymentRows(payment, 100);
  const buttons = rows[0].components.map(button => button.toJSON());
  assert.equal(buttons[0].url, `https://pay.example/payments/ecpay/service/insite?order=${order}`);
  assert.equal(buttons[0].label, "站內刷卡");
  assert.deepEqual(buttons.slice(1).map(button => button.custom_id), [
    `ecpay_direct_ATM_${order}`, `ecpay_direct_CVS_${order}`, `ecpay_direct_BARCODE_${order}`,
  ]);
  assert.equal(buildEcpayPaymentRows(payment, 100, { topup: true })[0].components.length, 2);
  } finally { Date.now = originalNow; }
});

test("自助訂單選擇單一綠界方式時只顯示該方式", () => {
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  try {
    const card = buildEcpayPaymentRows(payment, 100, { onlyMethod: "CARD" })[0].components.map(button => button.toJSON());
    assert.deepEqual(card.map(button => button.label), ["站內刷卡"]);
    const cvs = buildEcpayPaymentRows(payment, 100, { onlyMethod: "CVS" })[0].components.map(button => button.toJSON());
    assert.deepEqual(cvs.map(button => button.label), ["超商代碼"]);
    const barcode = buildEcpayPaymentRows(payment, 100, { onlyMethod: "BARCODE" })[0].components.map(button => button.toJSON());
    assert.deepEqual(barcode.map(button => button.label), ["超商條碼"]);
  } finally { Date.now = originalNow; }
});

test("虛擬 ATM 開放日前，按鈕隱藏且匯款仍走原帳號", () => {
  assert.equal(isEcpayAtmAvailable(ECPAY_ATM_START - 1), false);
  assert.equal(isEcpayAtmAvailable(ECPAY_ATM_START), true);
  const originalNow = Date.now;
  const originalFlag = process.env.ECPAY_ACCEPT_PAYMENTS;
  Date.now = () => ECPAY_ATM_START - 1;
  process.env.ECPAY_ACCEPT_PAYMENTS = "true";
  try {
    const buttons = buildEcpayPaymentRows(payment, 100)[0].components.map(button => button.toJSON());
    assert.equal(buttons.some(button => button.custom_id?.includes("_ATM_")), false);
    const selfService = buildEcpayPaymentRows(payment, 100, { onlyMethod: "ATM", selfService: true })[0].components.map(button => button.toJSON());
    assert.deepEqual(selfService.map(button => button.custom_id), [`ecpay_direct_ATM_${order}`]);
    const selected = getPaymentMethodSelection({ customId: "quote_payment_method_123", values: ["匯款"] }, "quote_payment_method_");
    assert.equal(selected.paymentMethod, "匯款");
    assert.equal(selected.requestedMethod, undefined);
    const oldButton = getPaymentMethodSelection({ customId: "quote_payment_method_123__pm_bank_account" }, "quote_payment_method_");
    assert.equal(oldButton.paymentMethod, "匯款");
    assert.equal(oldButton.requestedMethod, undefined);
  } finally {
    Date.now = originalNow;
    if (originalFlag === undefined) delete process.env.ECPAY_ACCEPT_PAYMENTS;
    else process.env.ECPAY_ACCEPT_PAYMENTS = originalFlag;
  }
});

test("選擇匯款時改走綠界虛擬 ATM，不再提供固定帳號", () => {
  const original = process.env.ECPAY_ACCEPT_PAYMENTS;
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  process.env.ECPAY_ACCEPT_PAYMENTS = "true";
  try {
    const selected = getPaymentMethodSelection({ customId: "quote_payment_method_123", values: ["匯款"] }, "quote_payment_method_");
    assert.equal(selected.paymentMethod, "綠界支付");
    assert.equal(selected.requestedMethod, "ATM");
    const oldButton = getPaymentMethodSelection({ customId: "quote_payment_method_123__pm_bank_account" }, "quote_payment_method_");
    assert.equal(oldButton.paymentMethod, "綠界支付");
    assert.equal(oldButton.requestedMethod, "ATM");
  } finally {
    Date.now = originalNow;
    if (original === undefined) delete process.env.ECPAY_ACCEPT_PAYMENTS;
    else process.env.ECPAY_ACCEPT_PAYMENTS = original;
  }
});

test("秋奈自助訂單依所選品牌建立付款，不再把綠界導到街口", () => {
  const source = readFileSync(join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const flow = source.split("async function paySelfServiceOrderByGateway(interaction) {")[1]
    .split("async function ")[0];
  assert.match(flow, /\.update\(\{ payment_method: paymentMethod, quote_status: waitingStatus/);
  assert.match(flow, /const payment = await createPayment\(\{/);
  assert.doesNotMatch(flow, /const payment = await paymentHelpers\.createJkopayServicePayment/);
});

test("自助單自動取號時先隱藏條碼按鈕，失敗才開放重試", () => {
  const source = readFileSync(join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const prompt = source.split("async function sendEcpayPaymentPrompt(channel, userId, amount, payment, label) {")[1]
    .split("async function sendBankTransferInfo")[0];
  assert.match(prompt, /components: autoIssueMethod \? \[\] : paymentRows/);
  assert.match(prompt, /if \(!issued\) \{/);
  assert.match(prompt, /throw new Error\("綠界取號資訊未成功送出/);
});

test("虛擬 ATM 取號後直接發到原付款頻道，未標記已付款", async () => {
  const atmOrder = `${order.slice(0, -1)}1`;
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  const sent = [];
  const channel = { id: "456", async send(payload) { sent.push(payload); return { id: "111111111111111111" }; } };
  const supabase = { from(table) {
    assert.equal(table, "ecpay_service_payments");
    return { select() { return this; }, update() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, payment_kind: "order" }, error: null }; } };
  } };
  const originalFetch = global.fetch;
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  global.fetch = async (url, init) => {
    assert.equal(url, "https://pay.example/api/payments/ecpay/service/direct-issue");
    assert.equal(JSON.parse(init.body).method, "ATM");
    return { ok: true, async json() { return { payment_info: { method: "ATM", expireDate: "2026/09/26",
      bankCode: "822", virtualAccount: "1234567890123456" } }; } };
  };
  try {
    assert.equal(await sendPreferredEcpayDirect(channel, "123", atmOrder, supabase, "https://pay.example"), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /虛擬帳號：`1234567890123456`/);
    assert.match(sent[0].content, /取號不代表已付款/);
  } finally { Date.now = originalNow; global.fetch = originalFetch; if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret; }
});

test("自助單超商代碼選定後可直接取號，且只在實際繳款後核帳", async () => {
  const cvsOrder = `${order.slice(0, -1)}2`;
  const sent = [];
  const channel = { id: "456", async send(payload) { sent.push(payload); return { id: "222222222222222222" }; } };
  const supabase = { from() { return { select() { return this; }, update() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, payment_kind: "order" } }; } }; } };
  const originalFetch = global.fetch;
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  global.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).method, "CVS");
    return { ok: true, async json() { return { payment_info: { method: "CVS", expireDate: "2026/09/26", paymentNo: "AB12345678" } }; } };
  };
  try {
    assert.equal(await sendPreferredEcpayDirect(channel, "123", cvsOrder, supabase, "https://pay.example", "CVS"), true);
    assert.match(sent[0].content, /超商繳費代碼：`AB12345678`/);
    assert.match(sent[0].content, /取號不代表已付款/);
  } finally {
    global.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret;
  }
});

test("超商條碼在 Discord 產生單張白底 PNG；已 defer 的互動不重複 defer", async () => {
  const barcodeOrder = `${order.slice(0, -1)}3`;
  const sent = [];
  const replies = [];
  const interaction = { customId: `ecpay_direct_BARCODE_${barcodeOrder}`, user: { id: "123" }, channelId: "456", deferred: true,
    channel: { async send(payload) { sent.push(payload); return { id: "333333333333333333" }; } },
    async deferReply() { throw new Error("重複 defer"); }, async editReply(payload) { replies.push(payload); } };
  const supabase = { from() { return { select() { return this; }, update() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, payment_kind: "order" }, error: null }; } }; } };
  const originalFetch = global.fetch;
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  global.fetch = async () => ({ ok: true, async json() { return { payment_info: { method: "BARCODE", expireDate: "2026/09/26 23:59:59",
    barcode: ["1407086CY", "1557341899384519", "0708B4000000100"] } }; } });
  try {
    await handleEcpayDirect(interaction, supabase, "https://pay.example");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].files.length, 1);
    const image = PNG.sync.read(sent[0].files[0].attachment);
    assert.equal(image.width > 600, true);
    assert.equal(image.height > 500, true);
    assert.deepEqual([...image.data.subarray(0, 4)], [255, 255, 255, 255]);
    assert.equal(image.data.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255), true);
    assert.match(sent[0].content, /條碼3/);
    await handleEcpayDirect(interaction, supabase, "https://pay.example");
    assert.equal(sent.length, 1);
    assert.match(replies.at(-1).content, /已發送過/);
  } finally { global.fetch = originalFetch; if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret; }
});

test("已取超商條碼的付款編號，不可誤回覆 ATM 資訊已送出", async () => {
  const replies = [];
  const interaction = { customId: `ecpay_direct_ATM_${order}`, user: { id: "123" }, channelId: "456", deferred: true,
    async editReply(payload) { replies.push(payload); },
    channel: { async send() { throw new Error("不應發送 ATM 付款資訊"); } } };
  const supabase = { from() { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 280,
      payment_kind: "order", organization_code: "qiunai", raw_result: { PaymentType: "BARCODE" },
      metadata: { flow: "self_service", ecpay_direct_method: "BARCODE", ecpay_direct_message_id: "old-message" } }, error: null }; } }; } };
  await handleEcpayDirect(interaction, supabase, "https://pay.example");
  assert.match(replies.at(-1).content, /無法改成ATM/);
  assert.doesNotMatch(replies.at(-1).content, /已發送過/);
});
