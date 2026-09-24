const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { isQiunaiCompanionInteraction } = require("../events/dispatchSystem");

test("只有秋奈陪陪身分組可使用 1／PM 跳單", () => {
  const withRoles = (roles) => ({ member: { roles } });
  assert.equal(isQiunaiCompanionInteraction(withRoles(["1206158440280621056"])), true);
  assert.equal(isQiunaiCompanionInteraction(withRoles(["1210852757972459540"])), true);
  assert.equal(isQiunaiCompanionInteraction(withRoles(["1525881173962788954"])), false);
  assert.equal(isQiunaiCompanionInteraction(withRoles([])), false);
  assert.equal(isQiunaiCompanionInteraction({}), false);
});

test("1／PM 按鈕及備註送出都會再次驗證陪陪身分", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  const open = source.slice(
    source.indexOf("async function openSelfServiceClaimModal"),
    source.indexOf("async function claimSelfServiceOrder"),
  );
  const submit = source.slice(
    source.indexOf("async function claimSelfServiceOrder"),
    source.indexOf("async function selectSelfServicePlayerNumbers"),
  );
  assert.match(open, /if \(!isQiunaiCompanionInteraction\(interaction\)\)/);
  assert.match(submit, /if \(!isQiunaiCompanionInteraction\(interaction\)\)/);
});
