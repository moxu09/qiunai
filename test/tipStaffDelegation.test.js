const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { canOperateTipFlow } = require("../utils/tipFlowAccess");

test("打賞人及客服可代為操作，其他人仍不能操作", () => {
  assert.equal(canOperateTipFlow({ actorId: "customer", creatorId: "customer" }), true);
  assert.equal(canOperateTipFlow({ actorId: "staff", creatorId: "customer", isCustomerService: true }), true);
  assert.equal(canOperateTipFlow({ actorId: "stranger", creatorId: "customer" }), false);
  assert.equal(canOperateTipFlow({ actorId: "", creatorId: "customer", isCustomerService: true }), false);
});

test("打賞內容客服可代操作，付款方式仍由打賞人選擇", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  for (const handler of [
    "handleTipBroadcastChoice",
    "handleTipBroadcastPrivacy",
    "handleCrownPackageSelect",
    "handleTipStaffPage",
    "handleTipGiftSelect",
    "handleTipStaffSelect",
    "openTipStaffSearchModal",
    "handleTipStaffSearchModal",
    "handleCrownSuffixChoice",
    "handleCrownSuffixModal",
    "handleTipStaffDone",
    "handleTipStaffClear",
  ]) {
    const start = source.indexOf(`function ${handler}`);
    assert.notEqual(start, -1, `缺少 ${handler}`);
    const next = source.indexOf("\nasync function ", start + 20);
    const block = source.slice(start, next === -1 ? source.length : next);
    assert.match(block, /canAdvanceTipFlow\(interaction, tipData\)/, `${handler} 未開放客服代操作`);
  }
  const paymentStart = source.indexOf("async function handleTipPaymentSelect(");
  const paymentEnd = source.indexOf("\nasync function ", paymentStart + 20);
  assert.match(source.slice(paymentStart, paymentEnd), /interaction\.user\.id !== String\(tipData\.tipperId\)/);
});

test("舊版打賞由頻道客人判斷自打賞，不會把代操作客服當成打賞人", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  const selectStart = source.indexOf('interaction.customId === "select_tip_staff"');
  const selectEnd = source.indexOf("// ===== 客人下單選陪陪", selectStart);
  const selectBlock = source.slice(selectStart, selectEnd);
  assert.match(selectBlock, /resolveTipperIdForChannel/);
  assert.match(selectBlock, /hasSelfTip\(tipperId, selectedStaffIds\)/);
  assert.doesNotMatch(selectBlock, /hasSelfTip\(interaction\.user\.id/);
  assert.match(selectBlock, /tipperId,/);
});
