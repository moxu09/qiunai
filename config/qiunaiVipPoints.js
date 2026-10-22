const VIP_POINTS_EFFECTIVE_AT = Date.parse("2026-10-10T00:00:00+08:00");
const { usesMembershipPolicy, applyMembershipPolicy } = require("./qiunaiMembership20261016");

// Two qualification paths: lifetime spending OR highest SINGLE ASD purchase.
// The deposit column in the supplied table intentionally does not participate.
const VIP_POINTS_LEVELS = [
  ["vip1", 9999, 9999, 100],
  ["vip2", 13214, 13000, 500],
  ["vip3", 20999, 19999, 1314],
  ["vip4", 32017, 31000, 2599],
  ["vip5", 66666, 65000, 3800],
  ["vip6", 88888, 86000, 5200],
  ["vip7", 111111, 105000, 8888],
  ["vip8", 131420, 121420, 9999],
  ["vip9", 177367, 165000, 11111],
  ["vip10", 201314, 188888, 13140],
  ["vvip1", 334420, 304420, 18888],
  ["vvip2", 511314, 480000, 23344],
  ["vvip3", 777777, 700000, 33440],
  ["vvip4", 921314, 820000, 45688],
  ["vvip5", 1314520, 1200000, 52000],
].map(([levelKey, totalSpendRequired, singleTopupRequired, rewardPoints], index) => ({
  levelKey, totalSpendRequired, singleTopupRequired, rewardPoints, sortOrder: index + 1,
}));

function isVipPointsActive(at = new Date()) {
  const timestamp = new Date(at).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("VIP 點數生效日期無效");
  return timestamp >= VIP_POINTS_EFFECTIVE_AT;
}

function calculateVipPointDiscount({ originalAmount, couponDiscount = 0, pointsBalance = 0, enabled = true, at = new Date() }) {
  for (const [name, value] of Object.entries({ originalAmount, couponDiscount, pointsBalance })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必須為非負整數`);
  }
  const appliedCouponDiscount = Math.min(originalAmount, couponDiscount);
  const couponAdjustedAmount = originalAmount - appliedCouponDiscount;
  const maximumPoints = Math.floor(couponAdjustedAmount / 2);
  const pointsUsed = enabled && isVipPointsActive(at) ? Math.min(pointsBalance, maximumPoints) : 0;
  return { originalAmount, couponDiscount: appliedCouponDiscount, couponAdjustedAmount, maximumPoints, pointsUsed, amountDue: couponAdjustedAmount - pointsUsed };
}

function getActiveVipLevels(levels, at = new Date()) {
  if (usesMembershipPolicy(levels)) return applyMembershipPolicy(levels);
  if (!isVipPointsActive(at)) return levels;
  return levels.map(level => {
    const next = VIP_POINTS_LEVELS.find(item => item.levelKey === level.level_key);
    if (!next) return level;
    return { ...level, total_spend_required: next.totalSpendRequired, single_topup_required: next.singleTopupRequired,
      reward_asd: 0, reward_points: next.rewardPoints,
      reward_note: String(level.reward_note || "")
        .replace(/累積消費[\d,]+[T元]?或單次(?:儲值|充值)[\d,]+(?:ASD|T|元)/g,
          `累積消費${next.totalSpendRequired.toLocaleString("zh-TW")}或單次購買${next.singleTopupRequired.toLocaleString("zh-TW")}ASD`)
        .replace(/獲得[\d,]+ASD/g, `獲得${next.rewardPoints}點`) };
  });
}

module.exports = { VIP_POINTS_EFFECTIVE_AT, VIP_POINTS_LEVELS, isVipPointsActive, calculateVipPointDiscount, getActiveVipLevels };
