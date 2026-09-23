const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getPendingClaimThreadOrderId,
  getClaimThreadOutcome,
  isSelfServiceClaimMessage,
  getDispatchResultThreadName,
} = require("../events/dispatchSystem");

const id = "123e4567-e89b-12d3-a456-426614174000";

test("自助派單按鈕移除後仍可由原訊息找回討論串", () => {
  const message = {
    content: "請在這個討論串內選擇「1」或「PM」並填寫接單備註。",
    components: [],
    embeds: [{ description: "訂單：ORD-123\n服務：特戰英豪" }],
  };
  assert.equal(isSelfServiceClaimMessage(message, id, "ORD-123"), true);
  assert.equal(isSelfServiceClaimMessage(message, id, "ORD-124"), false);
  assert.equal(isSelfServiceClaimMessage({ ...message, content: "接單成功！" }, id, "ORD-123"), false);
});

test("只補正可確認已成功或棄單的自助討論串", () => {
  assert.equal(getPendingClaimThreadOrderId(`派單中-ORD-123-${id}`), id);
  assert.equal(getPendingClaimThreadOrderId(`接單成功-ORD-123-${id}`), null);
  const self = { id, order_no: "ORD-123", note: "[SELF_SERVICE]", quote_status: "waiting_payment" };
  assert.equal(getClaimThreadOutcome(self), true);
  assert.equal(getDispatchResultThreadName(self, true), "接單成功-ORD-123");
  assert.equal(getClaimThreadOutcome({ ...self, quote_status: "self_dispatching" }), null);
  assert.equal(getClaimThreadOutcome({ ...self, quote_status: "cancelled" }), false);
  assert.equal(getClaimThreadOutcome({ ...self, note: "[MANUAL_DISPATCH]" }), null);
});

test("成功更名失敗時保留討論串供補正，啟動時掃描最近的封存討論串", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(source, /if \(thread\.name !== expectedName\) \{[\s\S]*?return null;/);
  assert.match(source, /fetchArchived\(\{ type: "public", limit: 100 \}\)/);
  assert.match(source, /repairSelfServiceClaimThreadNames\(\)/);
});
