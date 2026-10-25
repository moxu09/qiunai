const test = require("node:test");
const assert = require("node:assert/strict");
const { getCanonicalPaymentOptions, getPaymentMethodSelection } = require("../utils/paymentMethodEmojis");
const { handleEcpayDirect, assertBankTransferCanBeSelected } = require("../utils/ecpayDiscord");

test("人工訂單、續單的舊按鈕與選單都維持銀行匯款", () => {
  for (const prefix of ["quote_payment_method_", "service_payment_method_", "extension_payment_method_", "tip_payment_"]) {
    for (const interaction of [
      { customId: `${prefix}123`, values: ["匯款"] },
      { customId: `${prefix}123__pm_bank` },
    ]) {
      const selected = getPaymentMethodSelection(interaction, prefix);
      assert.equal(selected.paymentMethod, "匯款");
      assert.equal(selected.requestedMethod, undefined);
    }
  }
  const bank = getCanonicalPaymentOptions({ includeEcpay: true }).find(x => x.value === "匯款");
  assert.equal(bank.label, "匯款帳號");
  assert.doesNotMatch(bank.description, /虛擬|自動核帳/);
});

async function pressAtm(kind, metadata) {
  const replies = [];
  const supabase = { from() { return {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: {
      user_id: "123", channel_id: "456", status: "pending", amount: 100,
      payment_kind: kind, metadata,
    }, error: null }; },
  }; } };
  await handleEcpayDirect({
    customId: "ecpay_direct_ATM_QNMANUAL123", user: { id: "123" },
    channelId: "456", guildId: "789", deferred: true,
    async editReply(payload) { replies.push(payload); },
  }, supabase, "https://pay.example");
  return replies.at(-1).content;
}

test("人工單及續單的舊 ATM 按鈕不會呼叫綠界新取號", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("不應呼叫取號 API"); };
  try {
    for (const kind of ["order", "extension", "tip"]) {
      assert.match(await pressAtm(kind, { flow: "service" }), /請使用原銀行匯款/);
    }
  } finally { global.fetch = originalFetch; }
});

test("已發出的人工 ATM 帳號仍指向原繳費資訊，不建立新帳號", async () => {
  assert.match(await pressAtm("order", {
    flow: "service", ecpay_direct_method: "ATM", ecpay_direct_message_id: "existing",
  }), /此筆繳費資訊已發送過/);
});

test("續單已有有效綠界帳號或付款時，不可改成另一個收款帳號", async () => {
  function database(data, error = null) {
    return { from() { return {
      select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data, error }; },
    }; } };
  }
  await assertBankTransferCanBeSelected(database(null), "extension", "123");
  await assert.rejects(assertBankTransferCanBeSelected(database({
    status: "pending", metadata: { ecpay_direct_method: "ATM" },
  }), "extension", "123"), /已有有效綠界/);
  await assert.rejects(assertBankTransferCanBeSelected(database({ status: "paid" }), "extension", "123"), /已付款/);
  await assert.rejects(assertBankTransferCanBeSelected(database(null, { message: "db error" }), "extension", "123"), /無法核對/);
});
