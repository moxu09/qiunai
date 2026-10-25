const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateSalaryDeductionState } = require("../utils/salaryDeduction");
test("扣薪消費剛好30000可使用，再多1元拒絕", () => {
  const data = { walletEntries: [{ amount: 100000 }], monthlyDeductions: [{ amount: -29900 }], amount: 100 };
  assert.equal(calculateSalaryDeductionState(data).canUse, true);
  assert.equal(calculateSalaryDeductionState({ ...data, amount: 101 }).canUse, false);
  assert.equal(calculateSalaryDeductionState({ ...data, amount: 101 }).monthlyRemaining, 100);
});
test("已結算扣薪仍占月額度，正數調整不會擴大額度", () => {
  const state = calculateSalaryDeductionState({ walletEntries: [{ amount: 100000 }], monthlyDeductions: [{ amount: -15000, wallet_settled_at: "2026-10-04" }, { amount: -15000 }, { amount: 5000 }], amount: 1 });
  assert.equal(state.monthlyUsed, 30000);
  assert.equal(state.monthlyAllowed, false);
});
