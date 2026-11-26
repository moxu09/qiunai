const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitize, RESPONSE_SCHEMA } = require("../utils/appOrderAssist");

const options = { games: ["特戰英豪"], services: ["娛樂"], ranks: [], traits: [], genders: [], units: ["小時"], platforms: ["PC"], companions: ["小璃", "嵐嵐"] };
const fields = { game: "特戰英豪", platform: null, serviceType: "娛樂", targetRank: null, companionRank: null, amount: 3, unit: "小時",
  companionCount: null, gender: null, preferred: null, traits: [], notes: null };
const confidence = Object.fromEntries(Object.keys(fields).map((k) => [k, 0.9]));

test("schema requires intent and tip so the model always answers them", () => {
  assert.deepEqual(RESPONSE_SCHEMA.required, ["intent", "fields", "confidence", "tip"]);
  assert.deepEqual(RESPONSE_SCHEMA.properties.intent.enum, ["order", "tip", "both"]);
});

test("tip intent keeps a listed companion, the ASD amount and a short message", () => {
  const r = sanitize({ intent: "tip", fields, confidence, tip: { companion: "小璃", amount: 500, message: "辛苦了", confidence: 0.8 } }, options);
  assert.equal(r.intent, "tip");
  assert.deepEqual(r.tip, { companion: "小璃", amount: 500, message: "辛苦了", confidence: 0.8 });
});

test("both: order fields and tip are returned together", () => {
  const r = sanitize({ intent: "both", fields, confidence, tip: { companion: "嵐嵐", amount: 200, message: null, confidence: 0.7 } }, options);
  assert.equal(r.intent, "both");
  assert.equal(r.fields.game, "特戰英豪");
  assert.equal(r.tip.companion, "嵐嵐");
});

test("unlisted companion, bad amounts and injected text are dropped", () => {
  const r = sanitize({ intent: "tip", fields, confidence, tip: { companion: "不存在", amount: 1.5, message: "a\nb", confidence: 5 } }, options);
  assert.equal(r.tip.companion, "");
  assert.equal(r.tip.amount, null);
  assert.equal(r.tip.message, "a b");
  assert.equal(r.tip.confidence, 1);
  assert.equal(sanitize({ intent: "tip", fields, confidence, tip: { companion: null, amount: 100001, message: null, confidence: 1 } }, options).tip.confidence, 0);
});

test("order intent, or an unknown / missing intent, never carries a tip", () => {
  for (const intent of ["order", "evil", undefined]) {
    const r = sanitize({ intent, fields, confidence, tip: { companion: "小璃", amount: 500, message: "x", confidence: 1 } }, options);
    assert.equal(r.intent, "order");
    assert.deepEqual(r.tip, { companion: "", amount: null, message: "", confidence: 0 });
  }
});
