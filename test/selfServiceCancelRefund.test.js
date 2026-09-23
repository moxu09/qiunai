const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getSelfServiceCancellationRefundAmount,
  requiresManualTimeoutReview,
} = require("../events/dispatchSystem");

test("自助下單選擇陪陪階段顯示延長與棄單按鈕及十秒關閉文案", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /延長派單時間（\+5 分鐘，限一次）/);
  assert.match(source, /setLabel\("棄單"\)/);
  assert.match(source, /self_selection_extend_/);
  assert.match(source, /self_service_cancel_refund_/);
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
