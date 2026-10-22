const test = require("node:test");
const assert = require("node:assert/strict");
const { VIP_POINTS_LEVELS, isVipPointsActive, calculateVipPointDiscount, getActiveVipLevels } = require("../config/qiunaiVipPoints");
const { createVipRewardCoordinator } = require("../utils/vipRewardDelivery");
const at = "2026-10-10T00:00:00+08:00";
test("點數制度依台灣時間10/10零時切換", () => {
  assert.equal(isVipPointsActive("2026-10-09T23:59:59+08:00"), false);
  assert.equal(isVipPointsActive(at), true);
});
test("切換新門檻不改動原福利，生效前維持原制", () => {
  const levels = [{ level_key: "vip1", total_spend_required: 3000, single_topup_required: 2800,
    reward_asd: 50, role_id: "existing-role", reward_coupon: "95折券", reward_note: "累積消費3000T或單次充值2800T｜獲得50ASD｜原福利" }];
  assert.equal(getActiveVipLevels(levels, "2026-10-09T23:59:59+08:00"), levels);
  const [level] = getActiveVipLevels(levels, at);
  assert.equal(level.total_spend_required, 9999);
  assert.equal(level.single_topup_required, 9999);
  assert.equal(level.reward_asd, 0);
  assert.equal(level.reward_points, 100);
  assert.equal(level.role_id, "existing-role");
  assert.equal(level.reward_coupon, "95折券");
  assert.equal(level.reward_note, "累積消費9,999或單次購買9,999ASD｜獲得100點｜原福利");
});
test("已領ASD的歷史等級不再發點數、優惠券或重播升級", async () => {
  const calls=[];
  const coordinator=createVipRewardCoordinator({ supabase: { rpc: async name => {
    calls.push(name); return { data: { historical_claim: true }, error: null };
  } }, deliver: async () => { throw new Error("不能重新發獎"); } });
  assert.deepEqual(await coordinator.applyAndDeliver({}), { state: "completed", historicalClaim: true });
  assert.deepEqual(calls, ["qiunai_apply_vip_level_reward"]);
});
test("100元預設最高折抵50點，餘額不足僅折抵現有點數", () => {
  assert.equal(calculateVipPointDiscount({ originalAmount: 100, pointsBalance: 1000, at }).amountDue, 50);
  assert.equal(calculateVipPointDiscount({ originalAmount: 100, pointsBalance: 30, at }).amountDue, 70);
});
test("先套原價優惠券，再依折後價格限50%點數", () => {
  const result = calculateVipPointDiscount({ originalAmount: 100, couponDiscount: 20, pointsBalance: 100, at });
  assert.equal(result.pointsUsed, 40);
  assert.equal(result.amountDue, 40);
  assert.equal(calculateVipPointDiscount({ originalAmount: 101, pointsBalance: 100, at }).pointsUsed, 50);
});
test("關閉點數或生效日前不折抵；VIP表完整15級且不納入押金", () => {
  assert.equal(calculateVipPointDiscount({ originalAmount: 100, pointsBalance: 100, enabled: false, at }).pointsUsed, 0);
  assert.equal(calculateVipPointDiscount({ originalAmount: 100, pointsBalance: 100, at: "2026-10-09T23:59:59+08:00" }).pointsUsed, 0);
  assert.equal(VIP_POINTS_LEVELS.length, 15);
  assert.deepEqual(VIP_POINTS_LEVELS[14], { levelKey: "vvip5", totalSpendRequired: 1314520, singleTopupRequired: 1200000, rewardPoints: 52000, sortOrder: 15 });
});
