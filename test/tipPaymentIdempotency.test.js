const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { matchesTipPaymentNote } = require("../utils/tipPaymentIdempotency");

test("街口打賞備註被冠名提醒改為 JSON 後仍可去重", () => {
  const note = "打賞｜街口:QIUNAI-TIP-ABC123:0";
  assert.equal(matchesTipPaymentNote(note, note), true);
  assert.equal(matchesTipPaymentNote(JSON.stringify({ originalNote: note, crownReminderSent: true }), note), true);
  assert.equal(matchesTipPaymentNote(JSON.stringify({ originalNote: `${note}1` }), note), false);
  assert.equal(matchesTipPaymentNote("打賞", note), false);
});

test("打賞入帳先檢查完整付款鍵，重送 callback 不重新新增訂單", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const section = source.match(/async function saveTipToPlayOrders\(\{([\s\S]*?)\nasync function /)?.[1];
  assert.ok(section);
  assert.match(section, /matchesTipPaymentNote\(order\.note, note\)/);
  assert.match(section, /if \(existing\) return existing;/);
});
