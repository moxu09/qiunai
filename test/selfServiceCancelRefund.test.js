const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getSelfServiceCancellationRefundAmount,
  isClaimSelectionExpired,
  requiresManualTimeoutReview,
} = require("../events/dispatchSystem");

test("自助下單報價、選人、確認與付款階段都有取消入口", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /延長派單時間（\+5 分鐘，限一次）/);
  assert.match(source, /self_service_quote_no_\$\{order\.id\}`\)\.setLabel\("按錯了，取消訂單"\)/);
  assert.match(source, /self_selection_extend_/);
  assert.match(source, /self_service_cancel_refund_/);
  assert.match(source, /"confirming_players"\];/);
  assert.match(source, /self_service_cancel_order_\$\{order\.id\}`\)\.setLabel\("按錯了，取消訂單"\)/);
  assert.match(source, /self_service_cancel_order_\$\{orderId\}`\)\.setLabel\("按錯了，取消訂單"\)/);
  assert.match(source, /async function cancelSelfServiceBeforePayment\(interaction\)/);
  assert.match(source, /p_expected_quote_status: \["waiting_payment"\]/);
  assert.match(source, /for \(const table of \["ecpay_service_payments", "jkopay_service_payments"\]\)/);
  assert.match(
    source,
    /感謝您使用自助下單系統，歡迎下次光臨，頻道將於十秒後關閉，再見/,
  );
  assert.match(source, /10_000/);
});

test("自助取消只退款已付款的 ASD 訂單", () => {
  assert.equal(
    getSelfServiceCancellationRefundAmount({ paid: false, final_price: 500 }),
    0,
  );
  assert.equal(
    getSelfServiceCancellationRefundAmount({
      paid: true,
      payment_method: "儲值卡",
      final_price: 500,
    }),
    500,
  );
  assert.throws(
    () =>
      getSelfServiceCancellationRefundAmount({
        paid: true,
        payment_method: "匯款",
        final_price: 500,
      }),
    /不是 ASD 付款/,
  );
});

test("派單逾時時已付款的非 ASD 訂單必須保留供人工處理", () => {
  assert.equal(requiresManualTimeoutReview({ paid: true, payment_method: "員工扣薪" }), true);
  assert.equal(requiresManualTimeoutReview({ paid: true, payment_method: "匯款" }), true);
  assert.equal(requiresManualTimeoutReview({ paid: true, payment_method: "信用卡" }), true);
  assert.equal(requiresManualTimeoutReview({ paid: true, payment_method: "ASD" }), false);
  assert.equal(requiresManualTimeoutReview({ paid: false, payment_method: "匯款" }), false);
  assert.equal(requiresManualTimeoutReview({ paid: true, payment_method: "ASD", note: "[MANUAL_DISPATCH]" }), true);
});

test("指令建立的人工派單逾時不論是否湊足陪陪都保留老闆原頻道", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const timeout = source.split("async function failSelfServiceDispatch(")[1]
    .split("function scheduleSelfServiceDispatchTimeout(")[0];
  assert.match(timeout, /const keepManualTicket = isManualDispatchOrder\(order\);/);
  assert.match(timeout, /原訂單頻道會保留，請在這裡聯繫客服確認是否重新派單/);
  assert.match(timeout, /if \(orderChannel && !keepManualTicket\) \{\s*setTimeout\(\(\) => orderChannel\.delete/);
  assert.match(source, /channel_id: pending\.channelId \|\| interaction\.channel\.id/);
});

test("新增訂單的派單與選人不受 15 分鐘限制，原單可直接繼續", () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(isClaimSelectionExpired({ note: `[MANUAL_DISPATCH] [DISPATCH_AT:${past}]` }), false);
  assert.equal(isClaimSelectionExpired({ note: `[SELF_SERVICE] [DISPATCH_AT:${past}]` }), true);
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(source, /if \(isManualDispatchOrder\(sourceOrder\)\) return;/);
  assert.match(source, /if \(isManualDispatchOrder\(order\)\) return;\s*const remaining =/);
  assert.match(source, /const timedOrders = \(orders \|\| \[\]\)\.filter\(\(order\) => !isManualDispatchOrder\(order\)\);/);
  for (const handler of ["claimSelfServiceOrder", "selectSelfServicePlayerNumbers", "confirmSelfServicePlayers", "reselectSelfServicePlayers"]) {
    const body = source.split(`async function ${handler}(`)[1].split("\nasync function ")[0];
    assert.match(body, /isClaimSelectionExpired\(order\)/, `${handler} 必須只限制自助單`);
  }
  assert.match(source, /本單不設 15 分鐘派單期限/);
});

test("自助付款六種選項與一般訂單選項分流，先確認才建立付款", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const selfPayment = source.split("const SELF_SERVICE_PAYMENT_CHOICES = Object.freeze({")[1].split("});")[0];
  for (const label of ["街口支付", "線上刷卡", "匯款帳號", "超商條碼", "超商代碼", "錢包扣款"])
    assert.match(selfPayment, new RegExp(label));
  assert.match(source, /self_service_prepare_\$\{method\}_\$\{order\.id\}/);
  assert.match(source, /self_service_payment_back_\$\{orderId\}/);
  assert.ok(source.includes("const ecpayMatch = /^self_service_pay_ecpay_"));
  assert.match(source, /if \(isManualDispatchOrder\(order\)\) \{/);
});

test("9/28 前自助匯款保留原銀行並由客服確認，舊 ATM 按鈕不能提前取號", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const gateway = source.split("async function paySelfServiceOrderByGateway(interaction) {")[1]
    .split("async function paySelfServiceOrderByBank(")[0];
  assert.match(gateway, /!isEcpayAtmAvailable\(\) && \(bankMatch \|\| ecpayMatch\?\.\[1\] === "atm"\)/);
  assert.match(gateway, /paySelfServiceOrderByBank\(interaction/);
  const bank = source.split("async function paySelfServiceOrderByBank(interaction, orderId) {")[1]
    .split("async function confirmSelfServiceBankPayment(")[0];
  assert.match(bank, /quote_status: "waiting_bank"/);
  assert.match(bank, /sendBankTransferInfo\(interaction\.channel\)/);
  assert.match(bank, /self_service_bank_confirm_/);
  const confirm = source.split("async function confirmSelfServiceBankPayment(interaction) {")[1]
    .split("async function ")[0];
  assert.match(confirm, /memberHasRole\(interaction\.member, process\.env\.STAFF_ROLE\)/);
  assert.match(confirm, /action: "confirm_waiting"/);
  assert.match(confirm, /sendForAcceptedOrder\(accepted, selectedIds\)/);
});

test("扣薪差額未完成虛擬 ATM 核帳前，不可在切換日後先改訂單狀態再顯示舊銀行", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  for (const name of ["handleSalaryQuoteTransfer", "handleSalaryServiceTransfer"]) {
    const body = source.split(`async function ${name}(interaction) {`)[1].split("async function ")[0];
    const guard = body.indexOf("if (isEcpayAtmAvailable()) {");
    const bank = body.indexOf("sendBankTransferInfo(interaction.channel)");
    assert.ok(guard >= 0 && bank > guard, `${name} 必須先判斷切換時間`);
  }
});
